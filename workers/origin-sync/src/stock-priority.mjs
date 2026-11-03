/** Bounded extra stock pages using the existing lease/cursor protocol. No native writes. */
export async function collectPriorityStock(client, runPage, { deadline, clock = Date.now } = {}) {
  const start = client.requestsMade;
  const phaseDeadline = Math.min(deadline - 30000, clock() + 45000);
  const result = { status: 'completed', batches: 0, requested: 0, returned: 0,
    unavailable: 0, overlaps: 0, requests: 0, attempted: false,
    coverage_complete: false, errors: [], stop_json: false, stop_residual: false };
  const fail = code => { throw new Error(code); };
  const scopedClient = Object.freeze({
    async get(path, params, options = {}) {
      if (path !== '/estoques/saldos') fail('STOCK_PRIORITY_PATH_INVALID');
      if (clock() >= phaseDeadline) fail('STOCK_PRIORITY_TIME_BUDGET');
      if (client.requestsMade - start >= 9 || client.remainingRequests <= 14) fail('STOCK_PRIORITY_REQUEST_BUDGET');
      // A logical partition request is exactly one upstream attempt in this phase.
      return client.get(path, params, { deadline: Math.min(options.deadline ?? phaseDeadline, phaseDeadline), maxAttempts: 1 });
    },
  });
  for (let index = 0; index < 3; index++) {
    if (clock() + 5000 >= phaseDeadline) { result.status = result.batches ? 'completed' : 'skipped_time'; break; }
    if (client.remainingRequests < 17 || client.requestsMade - start > 6) { result.status = result.batches ? 'completed' : 'skipped_budget'; break; }
    result.attempted = true;
    try {
      const page = await runPage(scopedClient, phaseDeadline);
      if (page.skipped) { result.status = result.batches ? 'completed' : page.deferred ? 'deferred' : 'already_running'; break; }
      result.batches++;
      result.requested += page.requested; result.returned += page.records;
      result.unavailable += page.unavailable; result.overlaps += page.overlaps;
    } catch (error) {
      const raw = String(error?.code || error?.message || 'STOCK_PRIORITY_FAILED');
      const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(raw) ? raw : 'STOCK_PRIORITY_FAILED';
      const databaseUncertain = error?.databaseReleaseUnconfirmed || code.startsWith('DATABASE_');
      result.errors.push({ code }); result.status = 'partial';
      result.stop_json = Boolean(databaseUncertain || [401, 429].includes(error?.status));
      result.stop_residual = result.stop_json || error?.status === 403;
      break;
    }
  }
  result.requests = client.requestsMade - start;
  return result;
}
