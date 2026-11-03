import { sourceId } from './resources.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ENTITIES = ['receivables', 'payables'];
const RPC = 'origin_sync_finance_refresh_';
const codeOf = error => {
  const code = error?.code || error?.message;
  if (code === 'ORIGIN_HTTP_ERROR' && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
    return `ORIGIN_HTTP_${error.status}`;
  }
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code || '') ? code : 'FINANCE_REFRESH_FAILED';
};
const timestamp = value => typeof value === 'string' && value.length <= 40
  && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

function validCandidate(item) {
  if (!item || !ENTITIES.includes(item.entity) || typeof item.source_id !== 'string'
      || !HASH.test(item.source_hash) || !timestamp(item.source_seen_at)) return false;
  try { return sourceId(item.source_id) === item.source_id; } catch { return false; }
}

/**
 * Runs under the existing scheduler lease with its shared client, not a second
 * API budget. No title discovery, bank writes, settlement or ERP mutation.
 * The client may make at most three HTTP attempts per get; reserve all three.
 */
export async function refreshFinance(repo, client, {
  owner, lease, deadline, heartbeat = async () => {}, now = Date.now, staleSeconds = 3600,
} = {}) {
  if (!UUID.test(owner) || !UUID.test(lease?.lease_token) || !Number.isFinite(deadline)
      || !Number.isSafeInteger(staleSeconds) || staleSeconds < 300 || staleSeconds > 86400) {
    throw new Error('FINANCE_REFRESH_INVALID_OPTIONS');
  }
  const result = { status: 'completed', attempted: 0, stored: 0, unchanged: 0, conflicts: 0,
    unavailable_balance: 0, requests: 0, errors: [], stop_json: false };
  const startedRequests = client.requestsMade;
  const phaseDeadline = Math.min(deadline, now() + 40000);
  const room = () => {
    if (now() + 5000 >= phaseDeadline) return 'skipped_time';
    if (client.remainingRequests < 17 || client.requestsMade - startedRequests > 21) return 'skipped_budget';
    return null;
  };
  const early = room();
  if (early) return { ...result, status: early };
  let candidates;
  try {
    await heartbeat(phaseDeadline);
    candidates = await repo.rpc(RPC + 'candidates', {
      p_owner: owner, p_lease_token: lease.lease_token, p_limit: 8, p_stale_seconds: staleSeconds,
    }, { deadline: phaseDeadline });
    if (!Array.isArray(candidates?.items) || candidates.items.length > 8
        || !candidates.items.every(validCandidate)
        || new Set(candidates.items.map(item => `${item.entity}/${item.source_id}`)).size !== candidates.items.length) {
      throw new Error('FINANCE_REFRESH_INVALID_CANDIDATES');
    }
  } catch (error) {
    return { ...result, status: 'failed', errors: [{ code: codeOf(error) }] };
  }
  const suspended = new Set();
  for (const candidate of candidates.items) {
    if (suspended.has(candidate.entity)) continue;
    const skipped = room();
    if (skipped) { result.status = skipped; break; }
    let attempt;
    try {
      await heartbeat(phaseDeadline);
      // Freeze identity before the RPC so transport retries reuse one attempt.
      const attemptId = crypto.randomUUID();
      const args = { p_owner: owner, p_lease_token: lease.lease_token, p_attempt_id: attemptId,
        p_entity: candidate.entity, p_source_id: candidate.source_id, p_source_hash: candidate.source_hash,
        p_source_seen_at: candidate.source_seen_at, p_stale_seconds: staleSeconds };
      const begun = await repo.rpc(RPC + 'begin', args, { deadline: phaseDeadline });
      if (begun?.attempt_id !== attemptId || begun.entity !== candidate.entity || begun.source_id !== candidate.source_id
          || begun.source_hash !== candidate.source_hash || begun.source_seen_at !== candidate.source_seen_at
          || !['pending', 'stored', 'conflict', 'failed', 'superseded'].includes(begun.state)
          || typeof begun.replayed !== 'boolean') throw new Error('FINANCE_REFRESH_INVALID_ATTEMPT');
      if (begun.state !== 'pending') continue;
      attempt = begun;
      if (room()) throw new Error('FINANCE_REFRESH_TIME_OR_REQUEST_BUDGET');
      result.attempted++;
      const path = candidate.entity === 'receivables' ? '/contas/receber/' : '/contas/pagar/';
      const payload = await client.get(path + candidate.source_id, {}, {
        deadline: Math.min(phaseDeadline - 2000, now() + 18000),
      });
      if (!payload || Array.isArray(payload) || typeof payload !== 'object' || sourceId(payload.id) !== candidate.source_id
          || !['string', 'number'].includes(typeof payload.situacao) || !/^[1-7]$/.test(String(payload.situacao))) {
        throw new Error('FINANCE_REFRESH_INVALID_DETAIL');
      }
      await heartbeat(phaseDeadline);
      if (now() >= phaseDeadline) throw new Error('FINANCE_REFRESH_TIME_BUDGET');
      const saved = await repo.rpc(RPC + 'finish', {
        p_owner: owner, p_lease_token: lease.lease_token, p_attempt_id: attempt.attempt_id, p_payload: payload,
      }, { deadline: phaseDeadline });
      if (!saved || ['stored', 'conflict', 'unchanged', 'balance_available', 'replayed'].some(key => typeof saved[key] !== 'boolean')
          || saved.stored === saved.conflict || (!saved.stored && (saved.unchanged || saved.balance_available))) {
        throw new Error('FINANCE_REFRESH_INVALID_RESULT');
      }
      if (saved.stored) {
        result.stored++;
        if (saved.unchanged) result.unchanged++;
        if (!saved.balance_available) result.unavailable_balance++;
      } else { result.conflicts++; }
    } catch (error) {
      result.errors.push({ entity: candidate.entity, code: codeOf(error) });
      if (attempt && now() < phaseDeadline) {
        try {
          await repo.rpc(RPC + 'fail', { p_owner: owner, p_lease_token: lease.lease_token,
            p_attempt_id: attempt.attempt_id, p_code: codeOf(error),
            p_http_status: Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : null,
          }, { deadline: phaseDeadline });
        } catch { result.errors.push({ code: 'FINANCE_REFRESH_FAILURE_STATUS_UNAVAILABLE' }); }
      }
      if (error.status === 403) suspended.add(candidate.entity);
      if ([401, 429].includes(error.status)) { result.stop_json = true; break; }
    }
  }
  result.requests = client.requestsMade - startedRequests;
  if (result.errors.length) result.status = 'partial';
  return result;
}
