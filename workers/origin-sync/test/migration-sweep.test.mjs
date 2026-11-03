import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMigrationPlan, runMigrationSweep } from '../src/migration-sweep.mjs';
import { OriginClient } from '../src/client.mjs';

const owner = randomUUID(), scheduler = { lease_token: randomUUID() };
const fixedNow = Date.parse('2026-10-17T18:00:00Z');
const ids = count => Array.from({ length: count }, (_, index) => String(1000 + index));
const normal = { version: 1, recent: { page: 7, from: '2026-09-01 00:00:00' }, history: { page: 116 },
  unfiltered: { after: '123' }, nextLane: 'history', unrelated: { retained: true } };
const metadata = id => ({ source_id: id, exists: true, source_hash: 'a'.repeat(64), source_version: '1',
  last_seen_at: '2026-10-17T17:00:00.123456+00:00', document_links: [{ preserved: true, ref: 'synthetic' }] });
const missing = id => ({ source_id: id, exists: false, source_hash: null, source_version: null, last_seen_at: null, document_links: null });
const directed = (count = 3, resource = 'payables') => createMigrationPlan({ campaign: 'synthetic-20261017', resource, mode: 'directed',
  cutoff: '2026-10-17 15:00:00', sourceIds: ids(count) });
const windowPlan = () => createMigrationPlan({ campaign: 'synthetic-fiscal', resource: 'nfe_out', mode: 'window',
  from: '2024-01-01 00:00:00', cutoff: '2024-01-31 00:00:00' });

function fixture({ checkpoint = normal, existing = [], budget = 240, fetcher, loseAck, mutateAck, readMutator,
  beforeApply, release = true, renew = true, advance = 0, capture = true } = {}) {
  const state = { cp: structuredClone(checkpoint), version: 3, token: randomUUID(), sources: new Map(existing.map(id => [id, metadata(id)])) };
  const requests = [], commits = [], reads = [], claims = [], renewals = [], releases = [];
  let time = fixedNow, lost = false;
  const repo = {
    async claim(...args) { claims.push(args); return { acquired: true, lease_token: state.token, checkpoint_version: state.version, checkpoint: structuredClone(state.cp) }; },
    async renew(...args) { renewals.push(args); return { renewed: renew }; },
    async release(...args) { releases.push(args); return { released: release }; },
  };
  const readSources = async (_resource, wanted, options) => {
    reads.push({ wanted, options });
    const result = wanted.map(id => structuredClone(state.sources.get(id) ?? missing(id)));
    return readMutator ? readMutator(result) : result;
  };
  const applyRecords = async (resource, entity, actor, held, records, cp, expected, options) => {
    await beforeApply?.({ state, records, expected, cp });
    assert.equal(actor, owner); assert.equal(held.lease_token, state.token);
    if (held.checkpoint_version !== state.version) throw new Error('DATABASE_CHECKPOINT_CONFLICT');
    for (const source of expected) {
      if (JSON.stringify(source) !== JSON.stringify(state.sources.get(source.source_id) ?? missing(source.source_id))) throw new Error('DATABASE_SOURCE_CONFLICT');
    }
    let inserted = 0, updated = 0;
    for (const record of records) {
      assert.deepEqual(record.document_links, state.sources.get(record.source_id)?.document_links ?? []);
      state.sources.has(record.source_id) ? updated++ : inserted++;
      state.sources.set(record.source_id, { ...metadata(record.source_id), source_version: String(Number(state.sources.get(record.source_id)?.source_version ?? 0) + 1), document_links: structuredClone(record.document_links) });
    }
    state.cp = structuredClone(cp); state.version++;
    const commit = { resource, entity, records, cp: structuredClone(cp), expected: structuredClone(expected), options };
    commits.push(commit);
    const ack = { batch_id: options.batchId, checkpoint_version: state.version, inserted, updated, unchanged: 0, stale: 0, replayed: false };
    ack.migration_receipt = { profile: 'origin-migration-receipt-v1', request_sha256: 'b'.repeat(64), sources_sha256: 'c'.repeat(64),
      records: records.length, source_ids: records.map(row => row.source_id).sort(), guarded_source_ids: expected.map(row => row.source_id).sort(),
      migration_checkpoint: structuredClone(cp.migration), observed_at: new Date(time).toISOString() };
    const captures = records.filter(record => record.price_capture).length;
    if (captures) ack[entity === 'sales_orders' ? 'sales_price_captures' : entity === 'purchase_orders' ? 'purchase_price_captures' : 'price_captures'] = captures;
    if (!lost && loseAck?.(commit)) { lost = true; throw new Error('DATABASE_UNAVAILABLE'); }
    return mutateAck ? mutateAck(ack, commit) : ack;
  };
  const client = new OriginClient('synthetic-token', { apiOrigin: 'https://api.provider.example', maxRequests: budget, now: () => time, intervalMs: 700,
    sleep: async delay => { time += delay; }, salesPriceCaptureEnabled: capture, purchasePriceCaptureEnabled: capture, priceCaptureEnabled: capture,
    fetchImpl: async (url, init) => {
      requests.push({ url: new URL(url), method: init.method }); time += advance;
      if (fetcher) return fetcher(new URL(url), requests.length, { state });
      return new Response(`{"data":{"id":"${new URL(url).pathname.split('/').at(-1)}","itens":[{"valor":0.1234567891}]}}`);
    } });
  const run = (plan, extra = {}) => runMigrationSweep(repo, client, { owner, lease: scheduler, deadline: time + 160000, clock: () => time,
    heartbeat: async () => {}, plan, readSources, applyRecords, reserveRequests: 0, maxRequests: 120, ...extra });
  return { run, repo, client, state, requests, commits, reads, claims, renewals, releases, readSources, applyRecords,
    clock: () => time, advance: milliseconds => { time += milliseconds; } };
}

test('plan pins selection, profile and local window; unsafe or ambiguous configurations fail', async () => {
  const p = await directed(); assert.equal(p.hash.length, 64); assert.ok(Object.isFrozen(p.sourceIds));
  for (const change of [{ sourceIds: ['1', '1'] }, { sourceIds: ['01'] }, { sourceIds: [] }, { arbitrary: true },
    { cutoff: '2026-02-31 00:00:00' }, { sourceIds: ['2'] }, { resource: 'stock_balances', mode: 'window', from: '2024-01-01 00:00:00' }]) {
    await assert.rejects(createMigrationPlan({ ...p, ...change }));
  }
  await assert.rejects(createMigrationPlan({ campaign: 'x', resource: 'cash_entries_registered', mode: 'directed', cutoff: p.cutoff, sourceIds: ['1'] }), /UNSUPPORTED/);
  await assert.rejects(runMigrationSweep({}, {}, {}), /OPTIONS/);
});

test('directed52 resumes exact26+26 with chunks<=25 and preserves every ordinary cursor', async () => {
  const f = fixture(), p = await directed(52);
  const first = await f.run(p, { maxRequests: 26 });
  assert.equal(first.stored, 26); assert.equal(first.completed, false); assert.equal(first.status, 'skipped_budget');
  assert.equal(f.state.cp.migration.pending.offset, 26); assert.equal(f.state.cp.migration.directed_offset, 26);
  assert.deepEqual(f.commits.map(commit => commit.records.length), [0, 25, 1]);
  const second = await f.run(p);
  assert.equal(second.stored, 26); assert.equal(second.completed, true); assert.equal(second.coverage_complete, false);
  assert.equal(f.requests.length, 52); assert.ok(f.requests.every(request => request.method === 'GET'));
  assert.equal(new Set(f.requests.map(request => request.url.pathname)).size, 52);
  const { migration, ...unchanged } = f.state.cp; assert.deepEqual(unchanged, normal); assert.equal(migration.processed, 52);
  assert.equal(migration.pending, null); assert.equal((await f.run(p)).requests, 0);
});

test('100-row list is persisted before any detail and resumes frozen IDs without relisting', async () => {
  const p = await windowPlan(); let lists = 0;
  const f = fixture({ budget: 200, fetcher: url => {
    if (url.pathname.endsWith('/nfe')) { lists++; assert.equal(url.searchParams.get('limite'), '100');
      return Response.json({ data: lists === 1 ? ids(100).map(id => ({ id })) : [] }); }
    assert.equal(f.commits[0].records.length, 0); assert.equal(f.commits[0].cp.migration.pending.ids.length, 100);
    return Response.json({ data: { id: url.pathname.split('/').at(-1) } });
  } });
  assert.equal((await f.run(p, { maxRequests: 31 })).stored, 30);
  assert.equal(f.state.cp.migration.pending.offset, 30); assert.equal(lists, 1);
  const second = await f.run(p);
  assert.equal(second.stored, 70); assert.equal(second.completed, true); assert.equal(lists, 2);
  assert.equal(f.requests[0].url.searchParams.get('tipo'), '1'); assert.equal(f.requests.at(-1).url.searchParams.get('pagina'), '2');
});

test('fixed monthly windows overlap inclusively and a bounded empty passage never touches page10', async () => {
  const p = await createMigrationPlan({ campaign: 'months', resource: 'receivables', mode: 'window', from: '2024-01-01 00:00:00', cutoff: '2024-03-15 12:00:00' });
  const f = fixture({ fetcher: () => Response.json({ data: [] }) });
  const first = await f.run(p, { maxPages: 2 }); assert.equal(first.status, 'bounded'); assert.equal(first.completed, false);
  assert.deepEqual(f.requests.map(({ url }) => [url.searchParams.get('dataInicial'), url.searchParams.get('dataFinal')]),
    [['2024-01-01', '2024-01-31'], ['2024-01-31', '2024-03-01']]);
  assert.equal((await f.run(p)).completed, true); assert.deepEqual(f.state.cp.history, normal.history);
});

test('tampered pending IDs/fingerprint, changed plan and inconsistent counters never make GETs', async () => {
  const p = await directed(3), seed = fixture(); await seed.run(p, { maxRequests: 1 });
  for (const mutate of [cp => { cp.migration.pending.ids[1] = '999'; }, cp => { cp.migration.pending.fingerprint = 'b'.repeat(64); },
    cp => { cp.migration.processed++; }, cp => { cp.migration.plan_hash = 'c'.repeat(64); }]) {
    const cp = structuredClone(seed.state.cp); mutate(cp); const f = fixture({ checkpoint: cp });
    const result = await f.run(p); assert.equal(result.stop_json, true); assert.equal(f.requests.length, 0); assert.equal(f.commits.length, 0);
  }
});

test('lost list checkpoint ACK stops before GET; next claim resumes its durable page', async () => {
  const p = await directed(4), f = fixture({ loseAck: commit => commit.records.length === 0 });
  const first = await f.run(p); assert.equal(first.stop_json, true); assert.equal(first.stop_residual, true); assert.equal(f.requests.length, 0);
  assert.equal(f.commits.length, 1); assert.equal((await f.run(p)).stored, 4); assert.equal(f.commits.length, 2);
});

test('lost detail ACK never resends the command or GET; reclaimed checkpoint advances exactly once', async () => {
  const p = await directed(28), f = fixture({ loseAck: commit => commit.records.length > 0 });
  const first = await f.run(p); assert.equal(first.stop_json, true); assert.equal(first.stored, 0); assert.equal(f.requests.length, 25);
  assert.equal(f.state.cp.migration.directed_offset, 25); assert.equal(f.commits.length, 2);
  assert.equal((await f.run(p)).stored, 3); assert.equal(f.requests.length, 28);
  assert.equal(new Set(f.commits.map(commit => commit.options.batchId)).size, 3);
});

test('503 after a successful prefix persists only that prefix and retries unresolved ID next run', async () => {
  let failed = false; const p = await directed(5), f = fixture({ fetcher: url => {
    const id = url.pathname.split('/').at(-1);
    if (id === '1002' && !failed) { failed = true; return Response.json({}, { status: 503 }); }
    return Response.json({ data: { id } });
  } });
  const first = await f.run(p); assert.equal(first.stored, 2); assert.equal(first.status, 'partial'); assert.equal(first.stop_json, false);
  assert.equal(f.state.cp.migration.directed_offset, 2); assert.equal(f.requests.length, 3);
  assert.equal((await f.run(p)).stored, 3); assert.equal(f.requests[3].url.pathname.split('/').at(-1), '1002');
});

test('explicit404 is durably classified without deleting or rewriting existing source', async () => {
  const p = await directed(3), f = fixture({ existing: ['1001'], fetcher: url => url.pathname.endsWith('/1001')
    ? Response.json({ secret: 'MUST_NOT_LEAK' }, { status: 404 }) : Response.json({ data: { id: url.pathname.split('/').at(-1) } }) });
  const result = await f.run(p); assert.equal(result.completed, true); assert.equal(result.stored, 2); assert.equal(result.unavailable, 1);
  assert.deepEqual(f.state.sources.get('1001'), metadata('1001'));
  assert.deepEqual(f.commits.at(-1).expected.map(row => row.source_id), ['1000', '1002']);
  assert.equal(f.state.cp.migration.last_failures[0].http_status, 404);
  assert.doesNotMatch(JSON.stringify(result), /1001|MUST_NOT_LEAK|synthetic-token/);
});

test('401/403/429 stop both later phases, never retry GET or advance the failed item', async () => {
  for (const status of [401, 403, 429]) {
    const f = fixture({ fetcher: () => Response.json({}, { status }) }), result = await f.run(await directed(4));
    assert.equal(result.stop_json, true); assert.equal(result.stop_residual, true); assert.equal(f.requests.length, 1);
    assert.equal(f.state.cp.migration.directed_offset, 0); assert.equal(f.commits.length, 1);
  }
});

test('source CAS conflict after network leaves committed page but no detail/cursor update', async () => {
  const f = fixture({ existing: ['1000'], beforeApply: ({ state, records }) => {
    if (records.length) state.sources.set('1000', { ...state.sources.get('1000'), source_hash: 'b'.repeat(64) });
  } });
  const result = await f.run(await directed(1)); assert.equal(result.stop_json, true);
  assert.equal(f.state.cp.migration.directed_offset, 0); assert.equal(f.commits.length, 1); assert.equal(f.state.sources.get('1000').source_hash, 'b'.repeat(64));
});

test('prior document links survive unchanged and source metadata remains bound', async () => {
  const f = fixture({ existing: ['1000', '1001'] }); await f.run(await directed(2));
  assert.deepEqual(f.commits.at(-1).records.map(record => record.document_links), [metadata('1000').document_links, metadata('1001').document_links]);
  assert.equal(f.commits.at(-1).expected[0].source_version, '1'); assert.equal(f.commits.at(-1).expected[0].last_seen_at, metadata('1000').last_seen_at);
});

test('metadata must account for each exact identity, null missing fields, safe bigint and links', async () => {
  for (const readMutator of [rows => rows.slice(1), rows => [rows[0], rows[0]], rows => rows.map(row => ({ ...row, exists: false, document_links: [] })),
    rows => rows.map(row => ({ ...metadata(row.source_id), source_version: '9223372036854775808' }))]) {
    const f = fixture({ readMutator }), result = await f.run(await directed(2));
    assert.equal(result.stop_json, true); assert.equal(f.requests.length, 0); assert.equal(f.commits.length, 1);
  }
});

test('precise059/071/078 captures keep original decimal token and each ACK must confirm capture count', async () => {
  for (const resource of ['sales_orders', 'purchase_orders', 'sales_proposals']) {
    const f = fixture(), result = await f.run(await directed(1, resource));
    assert.equal(result.stored, 1); assert.ok(f.commits.at(-1).records[0].price_capture);
    assert.match(JSON.stringify(f.commits.at(-1).records[0].price_capture), /0\.1234567891/);
    const bad = fixture({ capture: false }); assert.equal((await bad.run(await directed(1, resource))).stop_json, true);
    assert.equal(bad.commits.length, 1);
  }
});

test('wrong detail identity or malformed list cannot advance or capture a different source', async () => {
  const f = fixture({ fetcher: () => Response.json({ data: { id: '9999' } }) });
  assert.equal((await f.run(await directed(1))).stop_json, true); assert.equal(f.state.cp.migration.directed_offset, 0);
  for (const list of [[{ id: '1' }, { id: '1' }], ids(101).map(id => ({ id })), [{ id: '01' }]]) {
    const g = fixture({ fetcher: () => Response.json({ data: list }) });
    assert.equal((await g.run(await windowPlan())).stop_json, true); assert.equal(g.commits.length, 0);
  }
});

test('wrong ACK UUID/version/count/replayed is uncertain even if server committed', async () => {
  for (const mutateAck of [ack => ({ ...ack, batch_id: randomUUID() }), ack => ({ ...ack, checkpoint_version: ack.checkpoint_version + 1 }),
    ack => ({ ...ack, inserted: 99 }), ack => ({ ...ack, replayed: undefined })]) {
    const f = fixture({ mutateAck }), result = await f.run(await directed(3));
    assert.equal(result.stop_json, true); assert.equal(f.requests.length, 0); assert.equal(f.commits.length, 1);
  }
});

test('time and request reservations bound GETs and retain confirmed prefix', async () => {
  const p = await directed(10), f = fixture({ budget: 10 });
  const r = await f.run(p, { reserveRequests: 4 }); assert.equal(r.requests, 6); assert.equal(f.client.remainingRequests, 4);
  const g = fixture(); assert.equal((await g.run(p, { deadline: fixedNow + 4999 })).status, 'skipped_time'); assert.equal(g.claims.length, 0);
  const h = fixture({ advance: 20000 }), r2 = await h.run(p, { deadline: fixedNow + 80000 });
  assert.equal(r2.requests, 4); assert.equal(r2.stop_json, true); assert.equal(h.commits.length, 1);
});

test('lease renewal is confirmed and any release uncertainty stops remaining work', async () => {
  const p = await directed(8), f = fixture({ advance: 10000 });
  await f.run(p); assert.equal(f.renewals.length, 1); assert.equal(f.releases.length, 1);
  const g = fixture({ advance: 10000, renew: false }); assert.equal((await g.run(p)).stop_json, true); assert.equal(g.commits.length, 1);
  const h = fixture({ release: false }); assert.equal((await h.run(await directed(1))).stop_json, true);
  const done = fixture({ checkpoint: f.state.cp, release: false }); assert.equal((await done.run(p)).stop_json, true);
});

test('checkpoint byte ceiling rejects oversized existing metadata before details', async () => {
  const f = fixture({ checkpoint: { ...normal, oversized: 'x'.repeat(65536) } });
  const result = await f.run(await directed(2)); assert.equal(result.stop_json, true); assert.equal(f.requests.length, 0); assert.equal(f.commits.length, 0);
});

test('directed stock performs three partitions, preserves cursor and collapses exact overlap', async () => {
  const f = fixture({ fetcher: url => {
    assert.equal(url.pathname, '/Api/v3/estoques/saldos'); assert.deepEqual(url.searchParams.getAll('idsProdutos[]'), ids(25));
    const partition = url.searchParams.get('filtroSaldoEstoque');
    return Response.json({ data: (partition === '0' ? ids(25).slice(0, 12) : partition === '1' ? ids(25).slice(12) : ['1000'])
      .map(id => ({ produto: { id }, saldoFisicoTotal: 0, depositos: [{ id: '7', saldoFisico: 0 }] })) });
  } });
  const result = await f.run(await directed(25, 'stock_balances'));
  assert.equal(result.completed, true); assert.equal(result.stored, 25); assert.equal(result.requests, 3);
  assert.deepEqual(f.state.cp.unfiltered, normal.unfiltered); assert.equal(f.commits.at(-1).records.length, 25);
});

test('stock missing IDs remain explicitly unavailable; conflicting overlap or foreign ID aborts whole observation', async () => {
  const p = await directed(3, 'stock_balances');
  const f = fixture({ fetcher: () => Response.json({ data: [{ produto: { id: '1000' }, saldoFisicoTotal: 0 }] }) });
  const r = await f.run(p); assert.equal(r.stored, 1); assert.equal(r.unavailable, 2); assert.equal(r.coverage_complete, false);
  for (const foreign of [false, true]) {
    const g = fixture({ fetcher: url => Response.json({ data: [{ produto: { id: foreign ? '999' : '1000' }, saldoFisicoTotal: Number(url.searchParams.get('filtroSaldoEstoque')) }] }) });
    assert.equal((await g.run(p)).stop_json, true); assert.equal(g.commits.length, 1); assert.equal(g.state.cp.migration.directed_offset, 0);
  }
});

test('stock reserves all three GETs before starting an observation', async () => {
  const f = fixture({ budget: 2 }); const r = await f.run(await directed(3, 'stock_balances'));
  assert.equal(r.status, 'skipped_budget'); assert.equal(f.requests.length, 0); assert.equal(f.commits.length, 1);
});

test('default091 RPC adapters bind scheduler/resource fences and fixed UUID before Repository retries', async () => {
  const f = fixture(), bodies = [];
  f.repo.rpc = async (name, args, options) => {
    bodies.push({ name, args, options });
    assert.equal(args.p_scheduler_token, scheduler.lease_token); assert.equal(args.p_resource_token, f.state.token);
    if (name === 'origin_sync_migration_sources') return f.readSources(args.p_resource, args.p_ids, options);
    assert.equal(name, 'origin_sync_migration_apply');
    return f.applyRecords(args.p_resource, args.p_entity, args.p_owner,
      { lease_token: args.p_resource_token, checkpoint_version: args.p_expected_checkpoint_version }, args.p_records,
      args.p_checkpoint, args.p_expected_sources, { ...options, batchId: args.p_batch_id });
  };
  const result = await runMigrationSweep(f.repo, f.client, { owner, lease: scheduler, deadline: fixedNow + 160000,
    clock: f.clock, plan: await directed(1), reserveRequests: 0 });
  assert.equal(result.stored, 1); assert.deepEqual(bodies.map(body => body.name), ['origin_sync_migration_apply', 'origin_sync_migration_sources', 'origin_sync_migration_apply']);
  assert.ok(bodies.every(body => body.options.deadline === fixedNow + 160000));
  assert.notEqual(bodies[0].args.p_batch_id, bodies[2].args.p_batch_id);
});

test('onlyMissing is pinned and counts guarded present sources separately without GET or writes', async () => {
  const base = await directed(5), { hash, ...input } = base;
  const p = await createMigrationPlan({ ...input, onlyMissing: true }); assert.notEqual(p.hash, hash);
  const f = fixture({ existing: ['1000', '1002', '1004'] }), result = await f.run(p);
  assert.equal(result.stored, 2); assert.equal(result.present, 3); assert.equal(result.completed, true); assert.equal(result.requests, 2);
  assert.equal(f.state.cp.migration.processed, 5); assert.equal(f.state.cp.migration.stored, 2); assert.equal(f.state.cp.migration.present, 3);
  assert.deepEqual(f.commits.at(-1).records.map(row => row.source_id), ['1001', '1003']);
  assert.deepEqual(f.commits.at(-1).expected.map(row => row.source_id), ids(5));
  assert.deepEqual(f.state.sources.get('1000'), metadata('1000'));
});

test('onlyMissing traversal can finish a full known page with zero detail GETs', async () => {
  const base = await windowPlan(), { hash, ...input } = base;
  const p = await createMigrationPlan({ ...input, onlyMissing: true }); let lists = 0;
  const f = fixture({ existing: ids(100), fetcher: () => Response.json({ data: ++lists === 1 ? ids(100).map(id => ({ id })) : [] }) });
  const result = await f.run(p); assert.equal(result.completed, true); assert.equal(result.present, 100); assert.equal(result.stored, 0); assert.equal(result.requests, 2);
  assert.ok(f.commits.every(commit => commit.records.length === 0)); assert.equal(f.commits.filter(commit => commit.expected.length === 25).length, 4);
});

test('a skipped present source changing before commit conflicts and cannot advance', async () => {
  const { hash, ...input } = await directed(1), p = await createMigrationPlan({ ...input, onlyMissing: true });
  const f = fixture({ existing: ['1000'], beforeApply: ({ state, expected }) => {
    if (expected.length) state.sources.delete('1000');
  } });
  const result = await f.run(p); assert.equal(result.stop_json, true); assert.equal(result.present, 0); assert.equal(result.requests, 0);
  assert.equal(f.state.cp.migration.directed_offset, 0); assert.equal(f.commits.length, 1);
});

test('stock and explicit price recapture plans cannot silently skip present sources', async () => {
  for (const resource of ['stock_balances', 'sales_orders', 'purchase_orders', 'sales_proposals']) {
    const { hash, ...input } = await directed(1, resource);
    await assert.rejects(createMigrationPlan({ ...input, onlyMissing: true }), /MIGRATION_SKIP_UNSUPPORTED/);
  }
});

test('receipt must prove exact identities, guarded sources and next migration checkpoint', async () => {
  for (const alter of [receipt => ({ ...receipt, profile: 'wrong' }), receipt => ({ ...receipt, source_ids: ['999'] }),
    receipt => ({ ...receipt, guarded_source_ids: ['999'] }), receipt => ({ ...receipt, migration_checkpoint: {} }),
    receipt => ({ ...receipt, request_sha256: null })]) {
    const f = fixture({ mutateAck: ack => ({ ...ack, migration_receipt: alter(ack.migration_receipt) }) });
    const result = await f.run(await directed(1)); assert.equal(result.stop_json, true); assert.equal(f.requests.length, 0);
    assert.equal(result.errors[0].code, 'MIGRATION_RECEIPT_INVALID');
  }
});

test('explicit supersedes opens a new finite plan only after the exact predecessor completed', async () => {
  const first = await directed(1), f = fixture(); assert.equal((await f.run(first)).completed, true);
  const second = await createMigrationPlan({ campaign: 'second-exact', resource: 'payables', mode: 'directed', cutoff: first.cutoff,
    sourceIds: ['9999'], supersedes: first.hash });
  const result = await f.run(second); assert.equal(result.completed, true); assert.equal(result.stored, 1);
  assert.equal(f.state.cp.migration.supersedes, first.hash); assert.equal(f.state.cp.migration.plan_hash, second.hash);
  assert.deepEqual(f.state.cp.recent, normal.recent); assert.deepEqual(f.state.cp.history, normal.history); assert.deepEqual(f.state.cp.unfiltered, normal.unfiltered);
  assert.equal(f.commits[1].cp.migration.plan_hash, first.hash); assert.ok(f.commits[1].cp.migration.completed_at);
});

test('supersedes cannot replace missing, unfinished, wrong or malformed predecessor', async () => {
  const p = await directed(3), f = fixture(); await f.run(p, { maxRequests: 1 });
  const next = await createMigrationPlan({ campaign: 'second', resource: 'payables', mode: 'directed', cutoff: p.cutoff, sourceIds: ['9999'], supersedes: p.hash });
  for (const cp of [normal, f.state.cp, { ...f.state.cp, migration: { ...f.state.cp.migration, completed_at: 'invalid' } },
    { ...f.state.cp, migration: { ...f.state.cp.migration, completed_at: new Date(fixedNow).toISOString(), pending: null, plan_hash: 'b'.repeat(64) } }]) {
    const candidate = fixture({ checkpoint: cp }); const result = await candidate.run(next);
    assert.equal(result.stop_json, true); assert.equal(candidate.requests.length, 0); assert.equal(candidate.commits.length, 0);
  }
});

test('a completed resource still rejects a different plan without its pinned predecessor hash', async () => {
  const p = await directed(1), f = fixture(); await f.run(p);
  const next = await createMigrationPlan({ campaign: 'replacement-without-proof', resource: 'payables', mode: 'directed', cutoff: p.cutoff, sourceIds: ['9999'] });
  const result = await f.run(next); assert.equal(result.stop_json, true); assert.equal(f.requests.length, 1); assert.equal(f.commits.length, 2);
});

test('source-page cash freezes150 IDs, resumes chunks25, and advances only after all IDs', async () => {
  const p = await createMigrationPlan({ campaign: 'cash-page', resource: 'cash_entries_registered', mode: 'window',
    from: '2024-01-01 00:00:00', cutoff: '2024-01-31 00:00:00' }); let lists = 0;
  const f = fixture({ budget: 240, fetcher: url => {
    if (url.pathname.endsWith('/caixas')) {
      lists++; assert.equal(url.searchParams.has('limite'), false); assert.equal(url.searchParams.get('situacao'), 'R');
      return Response.json({ data: lists === 1 ? ids(150).map(id => ({ id })) : [] });
    }
    return Response.json({ id: url.pathname.split('/').at(-1), data: '2024-01-10', valor: 1 });
  } });
  const first = await f.run(p, { maxRequests: 101 }); assert.equal(first.stored, 100); assert.equal(first.completed, false);
  assert.equal(f.state.cp.migration.page_size, 1000); assert.equal(f.state.cp.migration.pending.ids.length, 150);
  assert.equal(f.state.cp.migration.pending.offset, 100); assert.equal(f.state.cp.migration.page, 1); assert.equal(lists, 1);
  const second = await f.run(p); assert.equal(second.stored, 50); assert.equal(second.completed, true); assert.equal(lists, 2);
  assert.equal(f.requests.at(-1).url.searchParams.get('pagina'), '2'); assert.deepEqual(f.state.cp.history, normal.history);
});

test('a short non-empty source page never closes its window; only the later empty page does', async () => {
  const p = await createMigrationPlan({ campaign: 'cash-short', resource: 'cash_entries_deleted', mode: 'window',
    from: '2024-01-01 00:00:00', cutoff: '2024-01-31 00:00:00' });
  const f = fixture({ fetcher: url => {
    if (url.pathname.endsWith('/caixas')) {
      const page = Number(url.searchParams.get('pagina')); assert.equal(url.searchParams.get('situacao'), 'E');
      return Response.json({ data: page <= 2 ? [{ id: String(3000 + page) }] : [] });
    }
    return Response.json({ id: url.pathname.split('/').at(-1), data: '2024-01-10' });
  } });
  const result = await f.run(p); assert.equal(result.completed, true); assert.equal(result.stored, 2); assert.equal(result.pages, 3);
  assert.deepEqual(f.requests.filter(({ url }) => url.pathname.endsWith('/caixas')).map(({ url }) => url.searchParams.get('pagina')), ['1', '2', '3']);
});

test('source pages above1000 IDs fail before checkpoint mutation and undated windows remain unsupported', async () => {
  const p = await createMigrationPlan({ campaign: 'cash-max', resource: 'cash_entries_registered', mode: 'window',
    from: '2024-01-01 00:00:00', cutoff: '2024-01-31 00:00:00' });
  const f = fixture({ fetcher: () => Response.json({ data: ids(1001).map(id => ({ id })) }) });
  const result = await f.run(p); assert.equal(result.stop_json, true); assert.equal(f.commits.length, 0);
  await assert.rejects(createMigrationPlan({ campaign: 'no-unfiltered', resource: 'financial_categories', mode: 'window',
    from: p.from, cutoff: p.cutoff }), /MIGRATION_RESOURCE_UNSUPPORTED/);
});

test('catalog census omits modification dates, freezes a full page and resumes its canonical identities', async () => {
  const p = await createMigrationPlan({ campaign: 'catalog-census', resource: 'contacts', mode: 'catalog',
    cutoff: '2026-10-17 15:01:24', onlyMissing: true });
  let lists = 0;
  const f = fixture({ existing: ids(100), fetcher: url => {
    if (url.pathname.endsWith('/contatos')) {
      lists++;
      assert.deepEqual([...url.searchParams.keys()].sort(), ['criterio', 'limite', 'pagina']);
      assert.equal(url.searchParams.get('criterio'), '1');
      assert.equal(url.searchParams.get('limite'), '100');
      return Response.json({ data: (lists === 1 ? ids(100) : ['9999']).map(id => ({ id })) });
    }
    return Response.json({ data: { id: url.pathname.split('/').at(-1) } });
  } });
  assert.equal((await f.run(p, { maxRequests: 1 })).completed, false);
  assert.equal(f.state.cp.migration.pending.ids.length, 100);
  assert.equal(lists, 1);
  const resumed = await f.run(p);
  assert.equal(resumed.completed, true); assert.equal(resumed.present, 100); assert.equal(resumed.stored, 1);
  assert.equal(lists, 2); assert.equal(f.state.cp.migration.processed, 101);
  assert.equal(f.state.cp.migration.from, null); assert.equal(f.state.cp.migration.to, null);
  const { migration, ...unchanged } = f.state.cp; assert.deepEqual(unchanged, normal);
});

test('catalog census retains product stock/deletion filters and refuses date-window document endpoints', async () => {
  for (const [resource, criterion, partition] of [['products_zero', '5', '0'], ['products_positive', '5', '1'],
    ['products_negative', '5', '2'], ['products_deleted_zero', '4', '0'],
    ['products_deleted_positive', '4', '1'], ['products_deleted_negative', '4', '2']]) {
    const p = await createMigrationPlan({ campaign: 'catalog-partitions', resource, mode: 'catalog', cutoff: '2026-10-17 15:01:24' });
    const f = fixture({ fetcher: url => {
      assert.equal(url.searchParams.get('criterio'), criterion);
      assert.equal(url.searchParams.get('filtroSaldoEstoque'), partition);
      assert.equal(url.searchParams.get('tipo'), 'T');
      assert.equal(url.searchParams.has('dataAlteracaoInicial'), false);
      return Response.json({ data: [] });
    } });
    assert.equal((await f.run(p)).completed, true);
  }
  for (const resource of ['sales_orders', 'payables', 'receivables', 'nfe_out', 'cash_entries_registered', 'stock_balances']) {
    await assert.rejects(createMigrationPlan({ campaign: 'unsupported-census', resource, mode: 'catalog', cutoff: '2026-10-17 15:01:24' }), /MIGRATION_RESOURCE_UNSUPPORTED/);
  }
  for (const extra of [{ from: '2024-01-01 00:00:00' }, { sourceIds: ['1'] }]) {
    await assert.rejects(createMigrationPlan({ campaign: 'ambiguous-census', resource: 'contacts', mode: 'catalog',
      cutoff: '2026-10-17 15:01:24', ...extra }), /MIGRATION_CATALOG_INVALID/);
  }
});

test('undated source-page census consumes the complete frozen page and terminates on an empty page', async () => {
  const p = await createMigrationPlan({ campaign: 'category-census', resource: 'financial_categories', mode: 'catalog',
    cutoff: '2026-10-17 15:01:24', onlyMissing: true });
  let lists = 0;
  const f = fixture({ existing: ids(101), fetcher: url => {
    lists++; assert.equal(url.searchParams.get('limite'), '100');
    assert.equal(url.searchParams.get('tipo'), '0'); assert.equal(url.searchParams.get('situacao'), '0');
    return Response.json({ data: lists === 1 ? ids(101).map(id => ({ id })) : [] });
  } });
  const result = await f.run(p);
  assert.equal(result.completed, true); assert.equal(result.present, 101); assert.equal(result.stored, 0);
  assert.equal(lists, 2); assert.equal(f.state.cp.migration.processed, 101);
  assert.equal(f.commits[0].cp.migration.pending.ids.length, 101);
});
