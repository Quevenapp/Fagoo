import { createMigrationPlan } from './migration-sweep.mjs';
import { sha256 } from './crypto.mjs';

const PROFILE = 'origin-migration-scheduler-v1';
const HASH = /^[a-f0-9]{64}$/;
const fail = () => { throw new Error('MIGRATION_SCHEDULER_CONFIG_INVALID'); };

/** Private deployment input only. No HTTP endpoint accepts or returns this selection. */
export async function migrationPolicy(env) {
  if (env.MIGRATION_SWEEP_ENABLED !== 'true') return null;
  if (!Array.isArray(env.MIGRATION_SWEEP_PLANS) || !env.MIGRATION_SWEEP_PLANS.length
    || env.MIGRATION_SWEEP_PLANS.length > 40) fail();
  const plans = [];
  for (const input of env.MIGRATION_SWEEP_PLANS) {
    if (!HASH.test(input?.hash)) fail();
    plans.push(await createMigrationPlan(input));
  }
  const hashes = plans.map(plan => plan.hash);
  if (new Set(hashes).size !== hashes.length) fail();
  const lastByResource = new Map();
  for (const plan of plans) {
    const prior = lastByResource.get(plan.resource);
    if (prior && plan.supersedes !== prior.hash
      || !prior && plan.supersedes && hashes.includes(plan.supersedes)) fail();
    lastByResource.set(plan.resource, plan);
  }
  const cycleMs = Number(env.MIGRATION_SWEEP_CYCLE_MS ?? 180000);
  const intervalMs = Number(env.MIGRATION_SWEEP_INTERVAL_MS ?? 700);
  const maxRequests = Number(env.MAX_API_REQUESTS ?? 160);
  if (![120000, 180000].includes(cycleMs) || ![500, 700].includes(intervalMs)
    || !Number.isSafeInteger(maxRequests) || maxRequests < 40 || maxRequests > 160
    || Math.ceil(86400000 / cycleMs) * maxRequests > 96000) fail();
  const previousSelection = env.MIGRATION_SWEEP_PREVIOUS_SELECTION_SHA256 ?? null;
  if (previousSelection !== null && !HASH.test(previousSelection)) fail();
  return { profile: PROFILE, plans, hashes, selectionHash: await sha256(JSON.stringify(hashes)),
    previousSelection, cycleMs, intervalMs, maxRequests };
}

export function migrationSchedulerState(policy, previous, now) {
  const old = previous?.migration_sweep;
  const initial = { profile: PROFILE, selection_hash: policy.selectionHash,
    completed_plan_hashes: [], next_index: 0, started_at: now.toISOString(), completed_at: null };
  if (old === undefined) return initial;
  if (!old || old.profile !== PROFILE || !HASH.test(old.selection_hash)
    || !Array.isArray(old.completed_plan_hashes) || old.completed_plan_hashes.some(hash => !HASH.test(hash))
    || new Set(old.completed_plan_hashes).size !== old.completed_plan_hashes.length
    || !Number.isSafeInteger(old.next_index) || old.next_index < 0
    || typeof old.started_at !== 'string' || !Number.isFinite(Date.parse(old.started_at))) fail();
  if (old.selection_hash !== policy.selectionHash) {
    if (policy.previousSelection !== old.selection_hash) fail();
    return { ...initial, predecessor_selection_sha256: old.selection_hash,
      completed_plan_hashes: old.completed_plan_hashes.filter(hash => policy.hashes.includes(hash)) };
  }
  if (old.next_index >= policy.plans.length || old.completed_plan_hashes.some(hash => !policy.hashes.includes(hash))
    || old.completed_at !== null && (typeof old.completed_at !== 'string' || !Number.isFinite(Date.parse(old.completed_at)))
    || old.completed_at !== null && old.completed_plan_hashes.length !== policy.plans.length) fail();
  return structuredClone(old);
}

/** Dependencies preserve an explicit sequence when two plans use the same resource. */
export function nextMigrationPlan(policy, state, { durableCompleted = state.completed_plan_hashes } = {}) {
  for (let step = 0; step < policy.plans.length; step++) {
    const index = (state.next_index + step) % policy.plans.length;
    const plan = policy.plans[index];
    if (state.completed_plan_hashes.includes(plan.hash)) continue;
    if (plan.supersedes && policy.hashes.includes(plan.supersedes)
      && !durableCompleted.includes(plan.supersedes)) continue;
    return { index, plan };
  }
  return state.completed_plan_hashes.length === policy.plans.length ? null : { blocked: true };
}
