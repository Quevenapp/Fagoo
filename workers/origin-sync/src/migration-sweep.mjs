/** Finite, independently checkpointed GET collection. Never writes native ERP data. */
import { getResource, buildListParams, sourceId } from './resources.mjs';
import { sha256 } from './crypto.mjs';
import { priceCapture } from './price-json.mjs';
import { purchasePriceCapture } from './purchase-price-json.mjs';
import { salesPriceCapture } from './sales-price-json.mjs';

export const MIGRATION_SWEEP_PROFILE = 'origin-migration-sweep-v1';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]{0,39}$/;
const PAGE_SIZE = 100;
const SOURCE_PAGE_LIMIT = 1000;
const CATALOG_ENTITIES = new Set(['contacts', 'products', 'sellers', 'payment_methods', 'warehouses',
  'product_categories', 'financial_categories', 'ledger_accounts']);
const DAY = 86400000;
const fail = code => { throw new Error(code); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : plain(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || error?.message || '')
  ? error.code || error.message : 'MIGRATION_SWEEP_FAILED';
const stamp = value => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;

function localDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) fail('MIGRATION_DATE_INVALID');
  const parsed = Date.parse(value.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.replace(' ', 'T')) fail('MIGRATION_DATE_INVALID');
  return parsed;
}
const addDays = (value, count) => new Date(localDate(value) + count * DAY).toISOString().slice(0, 19).replace('T', ' ');
const earlier = (a, b) => a < b ? a : b;
function idsValid(ids, max) {
  return Array.isArray(ids) && ids.length <= max && ids.every(id => typeof id === 'string' && ID.test(id)) && new Set(ids).size === ids.length;
}
const pageLimit = plan => getResource(plan.resource).strategy === 'source_page' ? SOURCE_PAGE_LIMIT : PAGE_SIZE;

/** Pin the entire exact selection. Real selections belong in a private deploy input, never in Git. */
export async function createMigrationPlan(input) {
  if (!plain(input)) fail('MIGRATION_PLAN_INVALID');
  const allowed = ['profile', 'campaign', 'resource', 'mode', 'cutoff', 'from', 'sourceIds', 'hash', 'onlyMissing', 'supersedes'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || input.profile !== undefined && input.profile !== MIGRATION_SWEEP_PROFILE
    || typeof input.campaign !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(input.campaign)) fail('MIGRATION_PLAN_INVALID');
  const resource = getResource(input.resource);
  if (resource.strategy && !(resource.strategy === 'stock' && input.mode === 'directed')
    && !(resource.strategy === 'source_page' && input.mode === 'window' && resource.fromParam)
    && !(resource.strategy === 'source_page' && input.mode === 'catalog' && CATALOG_ENTITIES.has(resource.entity))
    || !['directed', 'window', 'catalog'].includes(input.mode)
    || input.mode === 'catalog' && !CATALOG_ENTITIES.has(resource.entity)) fail('MIGRATION_RESOURCE_UNSUPPORTED');
  if (input.onlyMissing !== undefined && typeof input.onlyMissing !== 'boolean'
    || input.onlyMissing === true && (resource.strategy === 'stock' || input.mode === 'directed' && ['sales_orders', 'purchase_orders', 'sales_proposals'].includes(resource.entity))) fail('MIGRATION_SKIP_UNSUPPORTED');
  if (input.supersedes !== undefined && !HASH.test(input.supersedes)) fail('MIGRATION_PREDECESSOR_INVALID');
  localDate(input.cutoff);
  const plan = { profile: MIGRATION_SWEEP_PROFILE, campaign: input.campaign, resource: resource.id, mode: input.mode, cutoff: input.cutoff, onlyMissing: input.onlyMissing ?? false };
  if (input.supersedes !== undefined) plan.supersedes = input.supersedes;
  if (input.mode === 'directed') {
    if (input.from !== undefined || !idsValid(input.sourceIds, 50000) || input.sourceIds.length === 0) fail('MIGRATION_SELECTION_INVALID');
    plan.sourceIds = [...input.sourceIds];
  } else if (input.mode === 'window') {
    if (input.sourceIds !== undefined || !resource.fromParam || localDate(input.from) > localDate(input.cutoff)) fail('MIGRATION_WINDOW_INVALID');
    plan.from = input.from;
  } else if (input.from !== undefined || input.sourceIds !== undefined) {
    fail('MIGRATION_CATALOG_INVALID');
  }
  const hash = await sha256(canonical(plan));
  if (input.hash !== undefined && input.hash !== hash) fail('MIGRATION_PLAN_HASH_MISMATCH');
  return Object.freeze({ ...plan, ...(plan.sourceIds ? { sourceIds: Object.freeze(plan.sourceIds) } : {}), hash });
}

function initialProgress(plan, now) {
  return {
    profile: MIGRATION_SWEEP_PROFILE, plan_hash: plan.hash, supersedes: plan.supersedes ?? null, resource: plan.resource, mode: plan.mode,
    page_size: pageLimit(plan), cutoff: plan.cutoff, from: plan.mode === 'window' ? plan.from : null,
    to: plan.mode === 'window' ? earlier(addDays(plan.from, 30), plan.cutoff) : null,
    page: 1, directed_offset: 0, pending: null, pages: 0, processed: 0, stored: 0, present: 0, unavailable: 0,
    last_failures: [], started_at: new Date(now).toISOString(), completed_at: null,
  };
}

async function validateProgress(progress, plan) {
  if (!plain(progress) || progress.profile !== MIGRATION_SWEEP_PROFILE || progress.plan_hash !== plan.hash
    || progress.supersedes !== (plan.supersedes ?? null)
    || progress.resource !== plan.resource || progress.mode !== plan.mode || progress.cutoff !== plan.cutoff || progress.page_size !== pageLimit(plan)
    || !integer(progress.page, 1) || !integer(progress.directed_offset, 0)
    || !['pages', 'processed', 'stored', 'present', 'unavailable'].every(key => integer(progress[key], 0))
    || progress.processed !== progress.stored + progress.present + progress.unavailable || !stamp(progress.started_at)
    || progress.completed_at !== null && !stamp(progress.completed_at)
    || !Array.isArray(progress.last_failures) || progress.last_failures.length > 25) fail('MIGRATION_CHECKPOINT_INVALID');
  if (plan.mode === 'window') {
    if (localDate(progress.from) < localDate(plan.from) || localDate(progress.from) > localDate(progress.to)
      || progress.to > plan.cutoff || localDate(progress.to) - localDate(progress.from) > 30 * DAY || progress.directed_offset !== 0) fail('MIGRATION_CHECKPOINT_INVALID');
  } else if (plan.mode === 'directed') {
    if (progress.from !== null || progress.to !== null || progress.directed_offset > plan.sourceIds.length
      || progress.processed !== progress.directed_offset) fail('MIGRATION_CHECKPOINT_INVALID');
  } else if (progress.from !== null || progress.to !== null || progress.directed_offset !== 0) fail('MIGRATION_CHECKPOINT_INVALID');
  if (progress.pending !== null) {
    const pending = progress.pending;
    if (!plain(pending) || !idsValid(pending.ids, pageLimit(plan)) || !pending.ids.length || !integer(pending.offset, 0, pending.ids.length - 1)
      || pending.fingerprint !== await sha256(canonical(pending.ids)) || typeof pending.last_page !== 'boolean') fail('MIGRATION_PAGE_FINGERPRINT_INVALID');
    if (getResource(plan.resource).strategy === 'source_page' && pending.last_page) fail('MIGRATION_PAGE_FINGERPRINT_INVALID');
    if (plan.mode === 'directed') {
      const start = progress.directed_offset - pending.offset;
      if (start < 0 || canonical(pending.ids) !== canonical(plan.sourceIds.slice(start, start + PAGE_SIZE))
        || pending.last_page !== (start + pending.ids.length === plan.sourceIds.length)) fail('MIGRATION_SELECTION_CHANGED');
    }
  }
  if (progress.completed_at && (progress.pending !== null || plan.mode === 'directed' && progress.directed_offset !== plan.sourceIds.length)) fail('MIGRATION_CHECKPOINT_INVALID');
  return progress;
}

function predecessorCompleted(previous, plan) {
  return plain(previous) && HASH.test(plan.supersedes) && previous.plan_hash === plan.supersedes
    && previous.profile === MIGRATION_SWEEP_PROFILE && previous.resource === plan.resource
    && previous.page_size === pageLimit(plan) && stamp(previous.completed_at) && previous.pending === null
    && ['processed', 'stored', 'present', 'unavailable'].every(key => integer(previous[key], 0))
    && previous.processed === previous.stored + previous.present + previous.unavailable;
}

function sourceMetadata(rows, ids) {
  if (!Array.isArray(rows) || rows.length !== ids.length) fail('MIGRATION_SOURCE_METADATA_INVALID');
  const wanted = new Set(ids), result = new Map();
  for (const row of rows) {
    if (!plain(row) || !wanted.has(row.source_id) || result.has(row.source_id) || typeof row.exists !== 'boolean') fail('MIGRATION_SOURCE_METADATA_INVALID');
    if (row.exists) {
      if (!HASH.test(row.source_hash) || typeof row.source_version !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.source_version)
        || BigInt(row.source_version) > 9223372036854775807n || !stamp(row.last_seen_at) || !Array.isArray(row.document_links)) fail('MIGRATION_SOURCE_METADATA_INVALID');
    } else if (['source_hash', 'source_version', 'last_seen_at', 'document_links'].some(key => row[key] !== null)) fail('MIGRATION_SOURCE_METADATA_INVALID');
    // Freeze metadata before any network/heartbeat callback can mutate its caller-owned response.
    result.set(row.source_id, structuredClone({ source_id: row.source_id, exists: row.exists, source_hash: row.source_hash,
      source_version: row.source_version, last_seen_at: row.last_seen_at, document_links: row.document_links }));
  }
  return result;
}

function nextPage(progress, plan, now) {
  const pending = progress.pending;
  if (pending && pending.offset < pending.ids.length) return;
  const last = pending?.last_page ?? true;
  progress.pending = null;
  if (plan.mode === 'directed') {
    if (progress.directed_offset === plan.sourceIds.length) progress.completed_at = new Date(now).toISOString();
  } else if (!last) progress.page++;
  else if (plan.mode === 'window' && progress.to < plan.cutoff) {
    // Inclusive boundaries intentionally overlap and canonical source IDs deduplicate.
    progress.from = progress.to; progress.to = earlier(addDays(progress.from, 30), plan.cutoff); progress.page = 1;
  } else progress.completed_at = new Date(now).toISOString();
}

async function stockDetails(client, ids, { deadline, keepLease }) {
  const wanted = new Set(ids), found = new Map(), contents = new Map();
  for (const partition of [0, 1, 2]) {
    await keepLease();
    const rows = await client.get('/estoques/saldos', { 'idsProdutos[]': ids, filtroSaldoEstoque: partition }, { deadline, maxAttempts: 1 });
    if (!Array.isArray(rows) || rows.length > ids.length) fail('MIGRATION_STOCK_RESPONSE_INVALID');
    const seen = new Set();
    for (const payload of rows) {
      if (!plain(payload)) fail('MIGRATION_STOCK_RESPONSE_INVALID');
      const id = sourceId(payload.produto?.id);
      if (!wanted.has(id) || seen.has(id)) fail('MIGRATION_STOCK_RESPONSE_CONFLICT');
      seen.add(id);
      if (payload.depositos !== undefined) {
        if (!Array.isArray(payload.depositos) || payload.depositos.length > 1000) fail('MIGRATION_STOCK_RESPONSE_INVALID');
        const deposits = payload.depositos.map(item => sourceId(item?.id));
        if (new Set(deposits).size !== deposits.length) fail('MIGRATION_STOCK_RESPONSE_CONFLICT');
      }
      const content = canonical(payload);
      if (found.has(id) && contents.get(id) !== content) fail('MIGRATION_STOCK_RESPONSE_CONFLICT');
      found.set(id, payload); contents.set(id, content);
    }
  }
  return found;
}

/**
 * Called under the existing scheduler lease, using its one serial OriginClient.
 * A listed page is persisted before its first detail GET. Each <=25-record commit
 * binds source CAS, links, cursor and ledger atomically via091. An uncertain ACK
 * stops this cycle; the next claim reads the durable checkpoint, never guesses.
 * Directed plans collect CURRENT details, not an as-of-cutoff source snapshot.
 */
export async function runMigrationSweep(repo, client, {
  owner, lease, deadline, heartbeat = async () => {}, plan: input, clock = Date.now,
  maxRequests = 120, reserveRequests = 14, chunkSize = 25, maxPages = 12,
  readSources, applyRecords,
} = {}) {
  if (!UUID.test(owner) || !UUID.test(lease?.lease_token) || !Number.isFinite(deadline) || !integer(maxRequests, 1, 240)
    || !integer(reserveRequests, 0, 120) || !integer(chunkSize, 1, 25) || !integer(maxPages, 1, 100)
    || !integer(client?.requestsMade, 0) || !integer(client?.remainingRequests, 0)) fail('MIGRATION_OPTIONS_INVALID');
  if (!HASH.test(input?.hash)) fail('MIGRATION_PLAN_HASH_REQUIRED');
  const plan = await createMigrationPlan(input), resource = getResource(plan.resource);
  const result = { status: 'completed', attempted: 0, stored: 0, present: 0, unavailable: 0, requests: 0, pages: 0,
    commits: 0, completed: false, coverage_complete: false, errors: [], stop_json: false, stop_residual: false };
  const startRequests = client.requestsMade;
  const room = () => clock() + 5000 >= deadline ? 'skipped_time'
    : client.remainingRequests <= reserveRequests || client.requestsMade - startRequests >= maxRequests ? 'skipped_budget' : null;
  const early = room();
  if (early) return { ...result, status: early };
  let resourceLease, checkpoint, progress, renewedAt = clock(), stage = 'claim';
  const dbOptions = { deadline };
  const keepLease = async () => {
    if (clock() >= deadline) fail('MIGRATION_TIME_BUDGET');
    await heartbeat(deadline);
    if (clock() - renewedAt >= 60000) {
      const renewed = await repo.renew(resource.id, owner, resourceLease.lease_token, 300, dbOptions);
      if (renewed?.renewed !== true) fail('MIGRATION_LEASE_UNCONFIRMED');
      renewedAt = clock();
    }
  };
  try {
    resourceLease = await repo.claim(resource.id, owner, 300, dbOptions);
    if (!plain(resourceLease) || typeof resourceLease.acquired !== 'boolean') fail('MIGRATION_LEASE_INVALID');
    if (!resourceLease.acquired) return { ...result, status: 'already_running' };
    if (!UUID.test(resourceLease.lease_token) || !integer(resourceLease.checkpoint_version, 0) || !plain(resourceLease.checkpoint)) fail('MIGRATION_LEASE_INVALID');
    checkpoint = structuredClone(resourceLease.checkpoint);
    if (checkpoint.migration === undefined) {
      if (plan.supersedes) fail('MIGRATION_PREDECESSOR_MISSING');
      progress = initialProgress(plan, clock());
    } else if (checkpoint.migration.plan_hash !== plan.hash) {
      if (!predecessorCompleted(checkpoint.migration, plan)) fail('MIGRATION_PREDECESSOR_UNCONFIRMED');
      progress = initialProgress(plan, clock());
    } else progress = await validateProgress(checkpoint.migration, plan);
    if (progress.completed_at) { result.completed = true; return result; }
    const read = readSources ?? ((name, ids, options) => repo.rpc('origin_sync_migration_sources', {
      p_resource: name, p_owner: owner, p_scheduler_token: lease.lease_token, p_resource_token: resourceLease.lease_token, p_ids: ids,
    }, options));
    const apply = applyRecords ?? ((name, entity, batchOwner, heldLease, records, cp, expected, options) => repo.rpc('origin_sync_migration_apply', {
      p_resource: name, p_entity: entity, p_owner: batchOwner, p_scheduler_token: lease.lease_token,
      p_resource_token: heldLease.lease_token, p_batch_id: options.batchId, p_records: records, p_checkpoint: cp,
      p_expected_checkpoint_version: heldLease.checkpoint_version, p_expected_sources: expected,
    }, { deadline: options.deadline }));
    const commit = async (records, expected) => {
      await keepLease();
      const cp = { ...checkpoint, migration: structuredClone(progress) };
      //091 reserves the rest of the base 64 KiB checkpoint allowance for its guard.
      if (bytes(cp) > 62000 || bytes(records) > 10485760) fail('MIGRATION_BATCH_SIZE_LIMIT');
      stage = 'apply';
      const batchId = crypto.randomUUID();
      const ack = await apply(resource.id, resource.entity, owner, resourceLease, records, cp, expected, { ...dbOptions, batchId });
      if (!plain(ack) || ack.batch_id !== batchId || ack.checkpoint_version !== resourceLease.checkpoint_version + 1
        || !['inserted', 'updated', 'unchanged', 'stale'].every(key => integer(ack[key], 0))
        || ack.inserted + ack.updated + ack.unchanged + ack.stale !== records.length || ack.stale !== 0
        || typeof ack.replayed !== 'boolean') fail('MIGRATION_ACK_INVALID');
      const receipt = ack.migration_receipt;
      if (!plain(receipt) || receipt.profile !== 'origin-migration-receipt-v1' || receipt.records !== records.length
        || !HASH.test(receipt.request_sha256) || !HASH.test(receipt.sources_sha256) || !stamp(receipt.observed_at)
        || canonical(receipt.source_ids) !== canonical(records.map(record => record.source_id).sort())
        || canonical(receipt.guarded_source_ids) !== canonical(expected.map(source => source.source_id).sort())
        || canonical(receipt.migration_checkpoint) !== canonical(cp.migration)) fail('MIGRATION_RECEIPT_INVALID');
      const captures = records.filter(record => record.price_capture).length;
      const captureField = resource.entity === 'sales_orders' ? 'sales_price_captures'
        : resource.entity === 'purchase_orders' ? 'purchase_price_captures' : 'price_captures';
      if (captures && ack[captureField] !== captures) fail('MIGRATION_CAPTURE_ACK_INVALID');
      checkpoint = cp; resourceLease = { ...resourceLease, checkpoint: cp, checkpoint_version: ack.checkpoint_version };
      result.commits++; result.stored += records.length; stage = 'between';
    };
    while (!progress.completed_at) {
      const skipped = room();
      if (skipped) { result.status = skipped; break; }
      if (!progress.pending) {
        if (result.pages >= maxPages) { result.status = 'bounded'; break; }
        let ids, last;
        if (plan.mode === 'directed') {
          ids = plan.sourceIds.slice(progress.directed_offset, progress.directed_offset + PAGE_SIZE);
          last = progress.directed_offset + ids.length === plan.sourceIds.length;
        } else {
          stage = 'list'; await keepLease();
          // A catalog census omits optional modification dates deliberately;
          // document endpoints retain their mandatory finite date windows.
          const params = plan.mode === 'catalog'
            ? { ...resource.baseParams, pagina: progress.page, limite: PAGE_SIZE }
            : buildListParams(resource, { from: resource.dateOnly ? progress.from.slice(0, 10) : progress.from,
              to: resource.dateOnly ? progress.to.slice(0, 10) : progress.to, page: progress.page, limit: PAGE_SIZE });
          const listed = await client.get(resource.path, params, { deadline: deadline - 5000, maxAttempts: 1 });
          if (!Array.isArray(listed) || listed.length > pageLimit(plan)) fail('MIGRATION_LIST_INVALID');
          ids = listed.map(item => sourceId(item?.id));
          if (!idsValid(ids, pageLimit(plan))) fail('MIGRATION_LIST_INVALID');
          // /caixas ignores an undocumented limite; only an empty source page
          // closes its window, even when a non-empty page has fewer than100 rows.
          last = resource.strategy === 'source_page' ? ids.length === 0 : ids.length < PAGE_SIZE;
        }
        progress.pages++; result.pages++;
        progress.pending = ids.length ? { ids, fingerprint: await sha256(canonical(ids)), offset: 0, last_page: last } : null;
        progress.last_failures = [];
        if (!ids.length) nextPage(progress, plan, clock());
        await commit([], []);
        if (progress.completed_at) break;
        if (!progress.pending) continue;
      }
      const available = Math.min(maxRequests - (client.requestsMade - startRequests), client.remainingRequests - reserveRequests);
      const capacity = resource.strategy === 'stock' ? available >= 3 ? chunkSize : 0 : Math.min(chunkSize, available);
      if (capacity <= 0) { result.status = 'skipped_budget'; break; }
      const ids = progress.pending.ids.slice(progress.pending.offset, progress.pending.offset + capacity);
      stage = 'sources'; await keepLease();
      const metadata = sourceMetadata(await read(resource.id, ids, dbOptions), ids);
      const records = [], expected = [], failures = [];
      let processed = 0, present = 0, delayedError = null;
      if (resource.strategy === 'stock') {
        stage = 'detail'; result.attempted += ids.length;
        const found = await stockDetails(client, ids, { deadline: deadline - 5000, keepLease });
        for (const id of ids) {
          const source = metadata.get(id);
          if (found.has(id)) {
            records.push({ source_id: id, payload: found.get(id), document_links: source.exists ? structuredClone(source.document_links) : [] });
            expected.push(source);
          } else failures.push({ source_id: id, code: 'MIGRATION_STOCK_SOURCE_UNAVAILABLE', http_status: 200, observed_at: new Date(clock()).toISOString() });
        }
        processed = ids.length;
      } else for (const id of ids) {
        const skipped = room();
        if (skipped) { result.status = skipped; break; }
        if (plan.onlyMissing && metadata.get(id).exists) {
          // No GET or synthetic write.091 guards this source in the same commit
          // as the cursor, even though the source is not in records.
          expected.push(metadata.get(id)); processed++; present++; continue;
        }
        stage = 'detail'; await keepLease(); result.attempted++;
        try {
          const payload = await client.get(resource.detailPath(id), {}, { deadline: deadline - 5000, maxAttempts: 1 });
          if (!plain(payload) || sourceId(payload.id) !== id) fail('MIGRATION_DETAIL_INVALID');
          const capture = resource.entity === 'sales_orders' ? salesPriceCapture(payload)
            : resource.entity === 'purchase_orders' ? purchasePriceCapture(payload) : priceCapture(payload);
          if (['sales_orders', 'purchase_orders', 'sales_proposals'].includes(resource.entity) && !capture) fail('MIGRATION_PRICE_CAPTURE_REQUIRED');
          const source = metadata.get(id);
          records.push({ source_id: id, payload, document_links: source.exists ? structuredClone(source.document_links) : [],
            ...(capture ? { price_capture: capture } : {}) });
          expected.push(source); processed++;
        } catch (error) {
          if (error?.status === 404) {
            // An explicit unavailable result closes this campaign item, never deletes a source.
            failures.push({ source_id: id, code: safeCode(error), http_status: 404, observed_at: new Date(clock()).toISOString() }); processed++;
          } else { delayedError = error; break; }
        }
      }
      if (processed) {
        progress.pending.offset += processed; progress.processed += processed; progress.stored += records.length;
        progress.present += present; progress.unavailable += failures.length; progress.last_failures = failures;
        if (plan.mode === 'directed') progress.directed_offset += processed;
        nextPage(progress, plan, clock());
        await commit(records, expected); result.present += present; result.unavailable += failures.length;
      }
      if (delayedError) { stage = 'detail'; throw delayedError; }
      if (!processed || result.status !== 'completed') break;
    }
    result.completed = progress.completed_at !== null;
  } catch (error) {
    result.status = 'partial'; result.errors.push({ code: safeCode(error), ...(integer(error?.status, 100, 599) ? { http_status: error.status } : {}) });
    // Fail closed for uncertain database responses, source conflicts or malformed data.
    result.stop_json = result.stop_residual = stage !== 'list' && stage !== 'detail'
      || [401, 403, 429].includes(error?.status) || ![404, 500, 502, 503, 504].includes(error?.status);
  } finally {
    if (resourceLease?.acquired && UUID.test(resourceLease.lease_token)) {
      try {
        const released = await repo.release(resource.id, owner, resourceLease.lease_token, dbOptions);
        if (released?.released !== true) fail('MIGRATION_RELEASE_UNCONFIRMED');
      } catch (error) {
        result.status = 'partial'; result.errors.push({ code: safeCode(error) }); result.stop_json = result.stop_residual = true;
      }
    }
    result.requests = client.requestsMade - startRequests;
  }
  return result;
}
