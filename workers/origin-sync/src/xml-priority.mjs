import { sha256 } from './crypto.mjs';

export const XML_PRIORITY_PROFILE = 'origin-xml-priority-v1';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
// PostgreSQL timestamps carry six fractional digits. Date.parse alone drops the
// final three and could acknowledge an observation just before the pinned cut.
const micros = value => {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!match) return null;
  const ms = Date.parse(value), day = new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));
  if (!Number.isFinite(ms) || day.getUTCFullYear() !== Number(match[1]) || day.getUTCMonth()+1 !== Number(match[2]) || day.getUTCDate() !== Number(match[3])) return null;
  return BigInt(Math.floor(ms/1000))*1000000n + BigInt((match[4]??'').padEnd(6,'0'));
};
const stamp = value => micros(value) !== null;
const identity = row => `${row.entity}/${row.source_id}/${row.key}`;
const fail = code => { throw new Error(code); };
const validCandidate = row => row && ['nfe','nfce'].includes(row.entity)
  && typeof row.source_id === 'string' && /^\d{1,40}$/.test(row.source_id)
  && typeof row.key === 'string' && /^\d{44}$/.test(row.key)
  && row.key.slice(20,22) === (row.entity === 'nfe' ? '55' : '65') && HASH.test(row.fingerprint);

/** Private deployment input. Identities are never accepted from an HTTP request or returned in a summary. */
export async function createXmlPriorityPlan(input) {
  if (!input || Object.keys(input).some(key => !['profile','campaign','snapshot_time','candidates','hash'].includes(key))
    || input.profile !== undefined && input.profile !== XML_PRIORITY_PROFILE
    || typeof input.campaign !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(input.campaign)
    || !stamp(input.snapshot_time) || !Array.isArray(input.candidates)
    || input.candidates.length < 1 || input.candidates.length > 50
    || input.candidates.some(row => !validCandidate(row) || Object.keys(row).length !== 4)
    || new Set(input.candidates.map(row => `${row.entity}/${row.source_id}`)).size !== input.candidates.length
    || new TextEncoder().encode(JSON.stringify(input)).length > 131072) fail('XML_PRIORITY_PLAN_INVALID');
  const plan = { profile: XML_PRIORITY_PROFILE, campaign: input.campaign, snapshot_time: input.snapshot_time,
    candidates: input.candidates.map(({entity,source_id,key,fingerprint}) => ({entity,source_id,key,fingerprint})) };
  const hash = await sha256(JSON.stringify(plan));
  if (input.hash !== undefined && input.hash !== hash) fail('XML_PRIORITY_PLAN_HASH_MISMATCH');
  return { ...plan, hash };
}

/**
 * Reconciles the scheduler's private checkpoint against confirmed XML attempts.
 * The scheduler persists checkpoint() with its existing CAS; lost scheduler ACKs
 * are recovered from this same read RPC before another Origin GET is considered.
 */
export async function createXmlPriority(repo, { owner, lease, plan: input, checkpoint, now = Date.now } = {}) {
  const plan = await createXmlPriorityPlan(input);
  if (!UUID.test(owner) || !UUID.test(lease?.lease_token) || BigInt(Math.floor(now()))*1000n < micros(plan.snapshot_time)) fail('XML_PRIORITY_CONTEXT_INVALID');
  const initial = { profile: XML_PRIORITY_PROFILE, plan_hash: plan.hash, snapshot_time: plan.snapshot_time,
    total: plan.candidates.length, cursor: 0, results: [], residuals: [], started_at: new Date(now()).toISOString(), completed_at: null };
  let state = checkpoint === undefined ? initial : structuredClone(checkpoint);
  const terminal = row => row && Number.isInteger(row.index) && row.index >= 0 && row.index < plan.candidates.length
    && ['stored','retry','blocked'].includes(row.outcome) && UUID.test(row.attempt_id)
    && stamp(row.finished_at) && micros(row.finished_at) >= micros(plan.snapshot_time)
    && Number.isInteger(row.files) && (row.outcome === 'stored' ? row.files >= 1 && row.files <= 10 && row.code === null : row.files === 0 && CODE.test(row.code))
    && typeof row.recovered === 'boolean';
  if (!state || state.profile !== XML_PRIORITY_PROFILE || state.plan_hash !== plan.hash
    || state.snapshot_time !== plan.snapshot_time || state.total !== plan.candidates.length
    || !Array.isArray(state.results) || state.results.some(row => !terminal(row))
    || new Set(state.results.map(row => row.index)).size !== state.results.length
    || !Array.isArray(state.residuals) || state.residuals.some(row => !Number.isInteger(row.index) || row.index < 0 || row.index >= plan.candidates.length || !CODE.test(row.code) || !stamp(row.observed_at))
    || new Set(state.residuals.map(row => row.index)).size !== state.residuals.length
    || !stamp(state.started_at) || state.completed_at !== null && (!stamp(state.completed_at) || state.results.length !== plan.candidates.length)) fail('XML_PRIORITY_CHECKPOINT_INVALID');
  const confirmed = new Map(state.results.map(row => [row.index,row]));
  const cursor = () => plan.candidates.findIndex((_row,index) => !confirmed.has(index));
  if (state.cursor !== (cursor() < 0 ? plan.candidates.length : cursor())) fail('XML_PRIORITY_CHECKPOINT_INVALID');
  const indices = new Map(plan.candidates.map((row,index) => [identity(row),index]));
  const offered = new Set();
  const refreshState = observed => {
    state.results = [...confirmed.values()].sort((a,b) => a.index-b.index);
    state.cursor = cursor() < 0 ? plan.candidates.length : cursor();
    state.residuals = state.residuals.filter(row => !confirmed.has(row.index));
    if (confirmed.size === plan.candidates.length) state.completed_at ??= observed;
  };
  const accept = (index, row, recovered, observed) => {
    if (!row.terminal_confirmed || micros(row.finished_at) < micros(plan.snapshot_time)) fail('XML_PRIORITY_TERMINAL_UNCONFIRMED');
    const value = { index, outcome: row.state, attempt_id: row.attempt_id, finished_at: row.finished_at,
      files: row.stored_files, code: row.state === 'stored' ? null : row.error_code, recovered };
    if (!terminal(value)) fail('XML_PRIORITY_TERMINAL_INVALID');
    const previous = confirmed.get(index);
    if (previous && (previous.attempt_id !== value.attempt_id || previous.outcome !== value.outcome)) fail('XML_PRIORITY_TERMINAL_CONFLICT');
    confirmed.set(index,value); refreshState(observed);
  };
  const read = async (requested, deadline) => {
    if (!Number.isFinite(deadline) || now() >= deadline) fail('XML_PRIORITY_TIME_LIMIT');
    const result = await repo.rpc('origin_sync_xml_priority_sources', {
      p_owner: owner, p_lease_token: lease.lease_token, p_candidates: requested,
    }, { deadline });
    if (now() >= deadline) fail('XML_PRIORITY_TIME_LIMIT');
    if (result?.profile !== 'origin-xml-priority-sources-v1' || !stamp(result.observed_at)
      || micros(result.observed_at) < micros(plan.snapshot_time)
      || !Array.isArray(result.items) || result.items.length !== requested.length) fail('XML_PRIORITY_SOURCES_INVALID');
    const rows = new Map();
    for (const row of result.items) {
      const wanted = requested.find(value => identity(value) === identity(row));
      if (!wanted || !validCandidate(row) || row.fingerprint !== wanted.fingerprint || rows.has(identity(row))
        || typeof row.source_exists !== 'boolean' || typeof row.source_matches !== 'boolean'
        || row.current_fingerprint !== null && !HASH.test(row.current_fingerprint)
        || row.source_matches && (!row.source_exists || row.current_fingerprint !== row.fingerprint)
        || ![null,'pending','stored','retry','blocked'].includes(row.state)
        || ![null,'pending','stored','retry','blocked','superseded'].includes(row.attempt_state)
        || row.attempt_id !== null && !UUID.test(row.attempt_id)
        || row.attempt_fingerprint !== null && !HASH.test(row.attempt_fingerprint)
        || row.started_at !== null && !stamp(row.started_at) || row.finished_at !== null && !stamp(row.finished_at)
        || row.next_attempt_at !== null && !stamp(row.next_attempt_at)
        || row.error_code !== null && !CODE.test(row.error_code)
        || typeof row.terminal_confirmed !== 'boolean' || typeof row.eligible !== 'boolean'
        || !Number.isInteger(row.stored_files) || row.stored_files < 0 || row.stored_files > 10
        || row.eligible && !row.source_matches
        || row.terminal_confirmed && (!row.source_matches || !['stored','retry','blocked'].includes(row.state)
          || row.state !== row.attempt_state || !UUID.test(row.attempt_id) || row.attempt_fingerprint !== row.fingerprint
          || !stamp(row.started_at) || !stamp(row.finished_at) || micros(row.finished_at) < micros(row.started_at)
          || micros(row.finished_at) > micros(result.observed_at))) fail('XML_PRIORITY_SOURCES_INVALID');
      rows.set(identity(row),row);
    }
    return { rows, observed: result.observed_at };
  };
  const candidateProvider = {
    async list({ limit, deadline }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 4) fail('XML_PRIORITY_LIMIT_INVALID');
      const pending = plan.candidates.filter((_row,index) => !confirmed.has(index));
      if (!pending.length) return { items: [] };
      const { rows, observed } = await read(pending,deadline);
      const items = []; state.residuals = [];
      for (const candidate of pending) {
        const index = indices.get(identity(candidate)), row = rows.get(identity(candidate));
        if (!row.source_matches) {
          state.residuals.push({index,code:'XML_PRIORITY_SOURCE_CHANGED',observed_at:observed});continue;
        }
        if (row.terminal_confirmed && micros(row.finished_at) >= micros(plan.snapshot_time)) {
          accept(index,row,true,observed);continue;
        }
        if (!row.eligible || row.state !== null && row.state !== 'pending' && !row.terminal_confirmed) {
          state.residuals.push({index,code:row.eligible?'XML_PRIORITY_TERMINAL_UNCONFIRMED':'XML_PRIORITY_BACKOFF',observed_at:observed});continue;
        }
        if (items.length < limit && !offered.has(index)) { offered.add(index);items.push(structuredClone(candidate)); }
      }
      refreshState(observed); return { items };
    },
    async settled(candidate, { attempt_id, deadline }) {
      const index = indices.get(identity(candidate));
      if (!offered.has(index) || !UUID.test(attempt_id) || candidate.fingerprint !== plan.candidates[index].fingerprint) fail('XML_PRIORITY_SETTLEMENT_INVALID');
      const { rows, observed } = await read([plan.candidates[index]],deadline), row = rows.get(identity(candidate));
      if (row.attempt_id !== attempt_id) fail('XML_PRIORITY_ATTEMPT_CHANGED');
      accept(index,row,false,observed);
    },
  };
  return {
    candidateProvider,
    checkpoint: () => structuredClone(state),
    summary: () => ({ status: confirmed.size === plan.candidates.length ? 'completed' : state.residuals.length ? 'partial' : 'pending',
      total: plan.candidates.length, confirmed: confirmed.size, stored: [...confirmed.values()].filter(row => row.outcome === 'stored').length,
      failed: [...confirmed.values()].filter(row => row.outcome !== 'stored').length, remaining: plan.candidates.length-confirmed.size,
      recovered: [...confirmed.values()].filter(row => row.recovered).length, residuals: state.residuals.length,
      all_targets_stored: confirmed.size === plan.candidates.length && [...confirmed.values()].every(row => row.outcome === 'stored'),
      coverage_complete: false }),
  };
}
