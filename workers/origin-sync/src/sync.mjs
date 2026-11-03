import { configuredEndpoint } from './endpoints.mjs';
import { RESOURCES, buildListParams } from './resources.mjs';
import { OriginClient } from './client.mjs';
import { priceCapture } from './price-json.mjs';
import { purchasePriceCapture, PURCHASE_PRICE_CAPTURE_PROFILE } from './purchase-price-json.mjs';
import { salesPriceCapture, SALES_PRICE_CAPTURE_PROFILE } from './sales-price-json.mjs';
import { accessToken } from './tokens.mjs';
import { collectXml } from './xml-sync.mjs';
import { refreshFinance } from './finance-refresh.mjs';
import { fetchMissingReferences } from './reference-fetch.mjs';
import { refreshProposalPrices } from './price-refresh.mjs';
import { refreshSalesPrices } from './sales-price-refresh.mjs';
import { collectPriorityStock } from './stock-priority.mjs';
import { projectStockMirror } from './stock-mirror.mjs';
import { EXTRA_FLAG, extraFailure, extraIsDeferred, cleanExtraCheckpoint, sourcePageSlice, stockBatch } from './extra-resources.mjs';
import { runMigrationSweep } from './migration-sweep.mjs';
import { migrationPolicy, migrationSchedulerState, nextMigrationPlan } from './migration-policy.mjs';
import { createXmlPriority, createXmlPriorityPlan } from './xml-priority.mjs';
import { continueSalesHistory, historyContinuationPolicy } from './history-continuation.mjs';

const PAGE_SIZE = 10;
const DAY = 86400000;

export function localTimestamp(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

// These are calendar strings in the configured source timezone, not UTC instants.
function addDays(value, days) {
  return new Date(Date.parse(value.replace(' ', 'T') + 'Z') + days * DAY).toISOString().slice(0, 19).replace('T', ' ');
}
const earlier = (a, b) => a < b ? a : b;
// The recent lane starts where the last completed pass started, less this overlap, instead of 30 days back every time: a pass over
// ~30 pages took hours on a 4-minute cron, so orders changed in the Origin (situação, nota, contas) stayed stale for an afternoon.
const RECENT_OVERLAP_DAYS = 15 / (24 * 60);

export function nextWindow(resource, checkpoint, cutoff, startDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(Date.parse(`${startDate}T00:00:00Z`))) {
    throw new Error('INVALID_SYNC_START_DATE');
  }
  const cp = structuredClone(checkpoint || {});
  if (cp.version && cp.version !== 1) throw new Error('UNSUPPORTED_CHECKPOINT');
  cp.version = 1;
  if (!resource.fromParam) return { cp, lane: 'unfiltered', cursor: cp.unfiltered || { page: 1 } };
  const lane = cp.nextLane || 'recent';
  let cursor = cp[lane];
  if (!cursor) {
    const since = lane === 'recent' && typeof cp.recentCompletedAt === 'string' ? addDays(cp.recentCompletedAt, -RECENT_OVERLAP_DAYS) : null;
    const from = lane === 'recent' ? (since && since > addDays(cutoff, -30) ? since : addDays(cutoff, -30)) : `${startDate} 00:00:00`;
    cursor = { from, to: earlier(addDays(from, 30), cutoff), cutoff, page: 1 };
  }
  return { cp, lane, cursor };
}

export function advanceWindow(state, count, cutoff) {
  const { cp, lane, cursor } = state;
  if (count >= PAGE_SIZE) {
    cp[lane] = { ...cursor, page: cursor.page + 1 };
  } else if (lane === 'history' && cursor.to < cursor.cutoff) {
    // Inclusive boundaries intentionally overlap; entity/source ID dedup handles repeats.
    const from = cursor.to;
    cp[lane] = { from, to: earlier(addDays(from, 30), cursor.cutoff), cutoff: cursor.cutoff, page: 1 };
  } else {
    delete cp[lane];
    cp[`${lane}CompletedAt`] = cutoff;
  }
  cp.nextLane = lane === 'recent' ? 'history' : 'recent';
  return cp;
}

function sourceId(record) {
  const id = record?.id;
  if ((typeof id === 'number' && (!Number.isSafeInteger(id) || id < 1))
      || !['number', 'string'].includes(typeof id) || !/^\d+$/.test(String(id))) {
    throw new Error('ORIGIN_INVALID_SOURCE_ID');
  }
  return String(id);
}

export async function syncPage(repo, client, resource, owner, env, now = new Date(), {
  clock = Date.now, deadline = clock() + 180000, heartbeat = async () => {}, boundDatabase = false,
} = {}) {
  const databaseOptions = boundDatabase ? { deadline } : undefined;
  const lease = await repo.claim(resource.id, owner, 300, databaseOptions);
  if (!lease.acquired) return { skipped: true };
  let lastRenewed = clock();
  const keepLease = async () => {
    if (clock() >= deadline) throw new Error('ORIGIN_PAGE_TIME_BUDGET');
    if (clock() - lastRenewed >= 60000) {
      await repo.renew(resource.id, owner, lease.lease_token, 300, databaseOptions);
      lastRenewed = clock();
    }
    await heartbeat(deadline);
  };
  let pageFailure;
  try {
    if(resource.extra&&extraIsDeferred(lease.checkpoint,clock()))return {skipped:true,deferred:true};
    const cutoff = localTimestamp(now, env.SYNC_TIME_ZONE || 'America/Sao_Paulo');
    if(resource.strategy==='stock')return await stockBatch(repo,client,owner,lease,lease.checkpoint,{keepLease,deadline,cutoff,clock,databaseOptions});
    const state = nextWindow(resource, lease.checkpoint, cutoff, env.SYNC_START_DATE);
    const params = buildListParams(resource, {
      from: resource.dateOnly ? state.cursor.from?.slice(0, 10) : state.cursor.from,
      to: resource.dateOnly ? state.cursor.to?.slice(0, 10) : state.cursor.to,
      page: state.cursor.page, limit: PAGE_SIZE,
    });
    await keepLease();
    const listed = await client.get(resource.path, params, {deadline});
    if (!Array.isArray(listed) || listed.length > (resource.strategy==='source_page'?1000:PAGE_SIZE)) throw new Error('ORIGIN_INVALID_LIST_RESPONSE');
    const sourceSlice=resource.strategy==='source_page'?await sourcePageSlice(listed,state.cursor):null;
    const records = [];
    for (const item of sourceSlice?.items??listed) {
      await keepLease();
      const id = sourceId(item);
      let payload;
      let capture;
      try {
        payload = await client.get(resource.detailPath(id),undefined,{deadline});
        capture = resource.entity === 'sales_orders' ? salesPriceCapture(payload) : resource.entity === 'purchase_orders' ? purchasePriceCapture(payload) : priceCapture(payload);
        if (!payload || Array.isArray(payload) || typeof payload !== 'object' || sourceId(payload) !== id) {
          throw new Error('ORIGIN_INVALID_DETAIL_RESPONSE');
        }
      } catch (error) {
        if (resource.id.includes('deleted') && error.status === 404) {
          payload = { ...item, _brufap_source: { deleted: true, detail_available: false } };
          capture = priceCapture(item, 'list_fallback');
        } else { throw error; }
      }
      records.push({ source_id: id, payload, ...(capture ? { price_capture: capture } : {}) });
    }
    await keepLease();
    let checkpoint;
    if(sourceSlice?.more){checkpoint=state.cp;checkpoint[state.lane]=sourceSlice.next;checkpoint.nextLane=state.lane;}
    else {if(sourceSlice){delete state.cursor.offset;delete state.cursor.list_fingerprint;}checkpoint=advanceWindow(state,resource.strategy==='source_page'&&listed.length>0?PAGE_SIZE:listed.length,cutoff);}
    if(resource.extra){checkpoint=cleanExtraCheckpoint(checkpoint);if(!resource.fromParam&&!checkpoint.unfiltered)checkpoint.next_attempt_at=new Date(clock()+900000).toISOString();}
    const result = await repo.apply(resource.id, resource.entity, owner, lease, records, checkpoint, databaseOptions);
    return { resource: resource.id, records: records.length, ...result };
  } catch(error) {
    pageFailure=error;
    // A database/ACK failure may already have committed. Never manufacture a
    // second checkpoint command to hide that uncertainty. Upstream failures can
    // record a bounded pause without advancing the failed page.
    if(resource.extra&&!String(error?.message||'').startsWith('DATABASE_')){
      try{await keepLease();await repo.apply(resource.id,resource.entity,owner,lease,[],{...lease.checkpoint,failure:extraFailure(error,lease.checkpoint?.failure,clock())},databaseOptions);}catch{/* Original error remains authoritative; next cron reclaims current state. */}
    }
    throw error;
  } finally {
    try{await repo.release(resource.id, owner, lease.lease_token, databaseOptions);}
    catch(error){if(!pageFailure)throw error;throw Object.assign(new Error(safeError(pageFailure)),{status:pageFailure.status,databaseReleaseUnconfirmed:true});}
  }
}

export function safeError(error) {
  const code = String(error?.code || error?.message || 'SYNC_FAILED');
  return /^[A-Z][A-Z0-9_]{0,80}$/.test(code) ? code : 'SYNC_FAILED';
}

export async function runSync(repo, env, { now = () => new Date(), clock = Date.now, getToken = accessToken, Client = OriginClient, resources = RESOURCES, xmlCollector = collectXml, financeRefresher = refreshFinance, referenceFetcher = fetchMissingReferences, priceRefresher = refreshProposalPrices, salesPriceRefresher = refreshSalesPrices, migrationSweeper = runMigrationSweep, historyContinuer = continueSalesHistory } = {}) {
  if (env.ORIGIN_ENABLED !== 'true' || env.SYNC_ENABLED !== 'true') return { status: 'disabled' };
  const apiOrigin = configuredEndpoint(env.ORIGIN_API_ORIGIN, { originOnly: true });
  const migration = await migrationPolicy(env);
  const historyPolicy = historyContinuationPolicy(env);
  const xmlPriorityOnly = env.XML_PRIORITY_ONLY === 'true';
  if (env.XML_PRIORITY_ONLY !== undefined && !['true','false'].includes(env.XML_PRIORITY_ONLY)
    || xmlPriorityOnly && env.XML_PRIORITY_ENABLED !== 'true') throw new Error('XML_PRIORITY_CONFIG_INVALID');
  let xmlPriorityPlan;
  if (env.XML_PRIORITY_ENABLED === 'true') {
    if (env.XML_SYNC_ENABLED !== 'true' || !/^[a-f0-9]{64}$/.test(env.XML_PRIORITY_PLAN?.hash)) throw new Error('XML_PRIORITY_CONFIG_INVALID');
    xmlPriorityPlan = await createXmlPriorityPlan(env.XML_PRIORITY_PLAN);
  }
  resources=resources.filter(r=>!r.extra||env[EXTRA_FLAG]==='true');
  const owner = crypto.randomUUID();
  const lease = await repo.claim('__scheduler__', owner, 600);
  if (!lease.acquired) return { status: 'already_running' };
  const previous = lease.checkpoint || {};
  let index = resources.length && Number.isSafeInteger(previous.nextIndex) && previous.nextIndex >= 0 ? previous.nextIndex % resources.length : 0;
  const started = now();
  const deadline = clock() + (migration?.cycleMs ?? 180000);
  const residualEnabled = env.XML_SYNC_ENABLED === 'true' && env.XML_RESIDUAL_ENABLED === 'true';
  const salesRefreshEnabled = env.SALES_PRICE_REFRESH_ENABLED === 'true' && env.SALES_PRICE_CAPTURE_ENABLED === 'true';
  const stockPriorityEnabled = env.STOCK_PRIORITY_ENABLED === 'true' && env[EXTRA_FLAG] === 'true';
  const stockMirrorEnabled = env.STOCK_MIRROR_ENABLED === 'true';
  const boundedCycle = Boolean(migration) || Boolean(historyPolicy) || residualEnabled || salesRefreshEnabled || stockPriorityEnabled || stockMirrorEnabled;
  const workDeadline = boundedCycle ? deadline - 20000 : deadline;
  const examinations = { visited: new Set(), stopped: false };
  let lastRenewed = clock();
  const heartbeat = async (phaseDeadline = workDeadline) => {
    if(clock()>=Math.min(workDeadline,phaseDeadline))throw new Error('SYNC_TIME_BUDGET');
    if (clock() - lastRenewed >= 60000) {
      await repo.rpc('origin_sync_renew', { p_resource: '__scheduler__', p_owner: owner,
        p_lease_token: lease.lease_token, p_ttl_seconds: 600 }, { deadline: Math.min(workDeadline, phaseDeadline) });
      lastRenewed = clock();
    }
  };
  const result = { status: 'completed', pages: 0, records: 0, errors: [], startedAt: started.toISOString() };
  let migrationState;
  let xmlPriority;
  let historyState;
  if (env.PRICE_CAPTURE_ENABLED === 'true') result.price_capture = { profile: 'origin-price-json-v1', records: 0, reference_records: 0, coverage_complete: false };
  if (env.PURCHASE_PRICE_CAPTURE_ENABLED === 'true') result.purchase_price_capture = { profile: PURCHASE_PRICE_CAPTURE_PROFILE, records: 0, coverage_complete: false };
  if (env.SALES_PRICE_CAPTURE_ENABLED === 'true') result.sales_price_capture = { profile: SALES_PRICE_CAPTURE_PROFILE, records: 0, coverage_complete: false };
  try {
    if (migration) migrationState = migrationSchedulerState(migration, previous, started);
    if (xmlPriorityPlan) xmlPriority = await createXmlPriority(repo, {owner,lease,plan:xmlPriorityPlan,
      checkpoint:previous.xml_priority,now:clock});
    const token = await getToken(repo, env);
    const budget = migration?.maxRequests ?? Math.max(20, Math.min(boundedCycle?120:240, Number(env.MAX_API_REQUESTS) || 120));
    const client = new Client(token, { apiOrigin, maxRequests: budget, deadline, ...(migration ? { intervalMs: migration.intervalMs } : {}), priceCaptureEnabled: env.PRICE_CAPTURE_ENABLED === 'true', purchasePriceCaptureEnabled: env.PURCHASE_PRICE_CAPTURE_ENABLED === 'true', salesPriceCaptureEnabled: env.SALES_PRICE_CAPTURE_ENABLED === 'true' });
    if(env.XML_SYNC_ENABLED==='true'){
      try{result.xml=await xmlCollector(repo,client,{owner,lease,deadline:workDeadline,heartbeat,now:clock,examinations,
        ...(xmlPriorityOnly||xmlPriority?.summary().remaining>0?{candidateProvider:xmlPriority.candidateProvider}:{})});}
      catch(error){examinations.stopped=true;result.xml={status:'failed',keys:0,files:0,unchanged:0,requests:0,errors:[{code:safeError(error)}],stop_json:[401,429].includes(error.status)};}
      if(result.xml.errors.length)result.errors.push({resource:'fiscal_xml',code:'XML_COLLECTION_PARTIAL'});
    }
    if (env.FINANCE_REFRESH_ENABLED === 'true' && !result.xml?.stop_json) {
      try {
        result.finance_refresh = await financeRefresher(repo, client, { owner, lease, deadline:workDeadline, heartbeat,
          staleSeconds: Number(env.FINANCE_REFRESH_STALE_SECONDS || 3600) });
      } catch (error) {
        result.finance_refresh = { status: 'failed', attempted: 0, stored: 0, unchanged: 0, conflicts: 0,
          unavailable_balance: 0, requests: 0, errors: [{ code: safeError(error) }], stop_json: [401, 429].includes(error.status) };
      }
      if (result.finance_refresh.errors.length) result.errors.push({ resource: 'finance_refresh', code: 'FINANCE_REFRESH_PARTIAL' });
    }
    if (env.REFERENCE_FETCH_ENABLED === 'true' && !result.xml?.stop_json && !result.finance_refresh?.stop_json) {
      try { result.reference_fetch = await referenceFetcher(repo, client, { owner, lease, deadline:workDeadline, heartbeat }); }
      catch (error) { result.reference_fetch = { status: 'failed', attempted: 0, stored: 0, conflicts: 0, requests: 0,
        errors: [{ code: safeError(error) }], stop_json: [401, 429].includes(error.status) }; }
      if (result.reference_fetch.errors.length) result.errors.push({ resource: 'proposal_references', code: 'REFERENCE_FETCH_PARTIAL' });
      if (result.price_capture) result.price_capture.reference_records = result.reference_fetch.price_captures || 0;
    }
    if (env.PRICE_REFRESH_ENABLED === 'true' && !result.xml?.stop_json && !result.finance_refresh?.stop_json && !result.reference_fetch?.stop_json) {
      try { result.price_refresh = await priceRefresher(repo, client, { owner, lease, deadline:workDeadline, heartbeat,
        enabled: true, priceCaptureEnabled: env.PRICE_CAPTURE_ENABLED === 'true' }); }
      catch (error) { result.price_refresh = { status: 'failed', attempted: 0, stored: 0, conflicts: 0, requests: 0,
        errors: [{ code: safeError(error) }], stop_json: [401, 429].includes(error.status) }; }
      if (result.price_refresh.errors.length) result.errors.push({ resource: 'proposal_prices', code: 'PRICE_REFRESH_PARTIAL' });
    }
    if (salesRefreshEnabled && !result.xml?.stop_json && !result.finance_refresh?.stop_json && !result.reference_fetch?.stop_json && !result.price_refresh?.stop_json) {
      try { result.sales_price_refresh = await salesPriceRefresher(repo, client, { owner, lease, deadline:workDeadline, heartbeat,
        now:clock, enabled:true, salesPriceCaptureEnabled:true }); }
      catch (error) { result.sales_price_refresh = { status:'failed',attempted:0,stored:0,conflicts:0,recovered:0,requests:0,
        errors:[{code:safeError(error)}],stop_json:true }; }
      if(result.sales_price_refresh.errors.length)result.errors.push({resource:'sales_price_refresh',code:'SALES_PRICE_REFRESH_PARTIAL'});
      if(result.sales_price_capture)result.sales_price_capture.directed_records=result.sales_price_refresh.stored;
    }
    const stockResource = resources.find(resource => resource.id === 'stock_balances' && resource.strategy === 'stock');
    if (stockPriorityEnabled && stockResource && !result.xml?.stop_json && !result.finance_refresh?.stop_json && !result.reference_fetch?.stop_json && !result.price_refresh?.stop_json && !result.sales_price_refresh?.stop_json) {
      result.stock_priority = await collectPriorityStock(client,
        (phaseClient, phaseDeadline) => syncPage(repo, phaseClient, stockResource, owner, env, now(),
          { deadline: phaseDeadline, heartbeat, clock, boundDatabase: true }),
        { deadline: workDeadline, clock });
      const phase = result.stock_priority;
      result.pages += phase.batches; result.records += phase.returned;
      if (phase.batches) result.stock_balances = { batches: phase.batches, requested: phase.requested,
        returned: phase.returned, unavailable: phase.unavailable, overlaps: phase.overlaps, coverage_complete: false };
      if (phase.errors.length) result.errors.push({ resource: 'stock_balances', code: 'STOCK_PRIORITY_PARTIAL' });
    }
    if (historyPolicy && ![result.xml,result.finance_refresh,result.reference_fetch,result.price_refresh,result.sales_price_refresh,result.stock_priority].some(phase=>phase?.stop_json)) {
      try {
        const continued=await historyContinuer(repo,{owner,lease,actor:historyPolicy.actor,checkpoint:previous.sales_history_continuation,
          maxBatches:historyPolicy.maxBatches,deadline:Math.min(workDeadline-30000,clock()+20000),heartbeat,clock});
        historyState=continued.checkpoint;result.sales_history_continuation=continued.result;
      } catch(error) {
        result.sales_history_continuation={status:'failed',batches:0,captured:0,rejected:0,residuals:0,recovered:0,passes:0,
          errors:[{code:safeError(error)}],stop_json:true,stop_residual:true,coverage_complete:false};
      }
      if(result.sales_history_continuation.errors.length)result.errors.push({resource:'sales_history',code:'HISTORY_CONTINUATION_PARTIAL'});
    }
    if (migration && ![result.xml,result.finance_refresh,result.reference_fetch,result.price_refresh,result.sales_price_refresh,result.stock_priority,result.sales_history_continuation].some(phase => phase?.stop_json)) {
      const phase = result.migration_sweep = { status: 'completed', attempted: 0, stored: 0, present: 0,
        unavailable: 0, requests: 0, pages: 0, plans_completed: migrationState.completed_plan_hashes.length,
        plan_count: migration.plans.length, coverage_complete: false, errors: [], stop_json: false, stop_residual: false };
      const before = client.requestsMade;
      // A successor may start only after its predecessor's completion was read
      // from a committed scheduler checkpoint, never from this cycle's memory.
      const durableCompleted = [...(previous.migration_sweep?.completed_plan_hashes ?? [])];
      for (let step = 0; step < migration.plans.length && client.remainingRequests > 14 && clock()+10000 < workDeadline; step++) {
        const target = nextMigrationPlan(migration,migrationState,{durableCompleted});
        if (!target) { migrationState.completed_at ??= now().toISOString(); break; }
        if (target.blocked) break;
        const part = await migrationSweeper(repo,client,{owner,lease,deadline:workDeadline,heartbeat,
          plan:target.plan,clock,maxRequests:Math.min(140,client.remainingRequests-14),reserveRequests:14});
        for (const field of ['attempted','stored','present','unavailable','pages']) phase[field] += part[field] ?? 0;
        phase.errors.push(...(part.errors ?? []).map(error => ({resource:target.plan.resource,...error})));
        phase.stop_json ||= part.stop_json === true; phase.stop_residual ||= part.stop_residual === true;
        migrationState.next_index = (target.index+1)%migration.plans.length;
        if (part.completed) migrationState.completed_plan_hashes.push(target.plan.hash);
        phase.plans_completed = migrationState.completed_plan_hashes.length;
        if (phase.plans_completed === migration.plans.length) migrationState.completed_at ??= now().toISOString();
        if (part.status !== 'completed') phase.status = part.status;
        if (part.stop_json || part.stop_residual
          || !part.completed && !['bounded', 'already_running'].includes(part.status)) break;
      }
      phase.requests = client.requestsMade-before;
      if (phase.errors.length) result.errors.push({resource:'migration_sweep',code:'MIGRATION_SWEEP_PARTIAL'});
    }
    // A failed resource does not starve the rest. An unfinished page never advances.
    let tailBlocked = result.stock_priority?.stop_residual === true || result.migration_sweep?.stop_residual === true || result.sales_history_continuation?.stop_residual === true;
    for (let step = 0; step < resources.length * 2 && client.remainingRequests >= PAGE_SIZE + 4&&!result.xml?.stop_json&&!result.finance_refresh?.stop_json&&!result.reference_fetch?.stop_json&&!result.price_refresh?.stop_json&&!result.sales_price_refresh?.stop_json&&!result.stock_priority?.stop_json&&!result.migration_sweep?.stop_json&&!result.sales_history_continuation?.stop_json; step++) {
      // A normal page shares this deadline with its claim, CAS and release.
      // Do not begin it with less than one request timeout left in a bounded cycle.
      if (clock() + (boundedCycle ? 15000 : 0) >= workDeadline) break;
      const resource = resources[index];
      // This resource already had its bounded opportunity; keep round-robin progress.
      if (resource.strategy === 'stock' && result.stock_priority?.attempted) { index = (index + 1) % resources.length; continue; }
      try {
        const page = await syncPage(repo, client, resource, owner, env, now(), { deadline:workDeadline, heartbeat, clock, boundDatabase:boundedCycle });
        if (!page.skipped) {
          result.pages++; result.records += page.records; if (result.price_capture) result.price_capture.records += page.price_captures || 0;
          if (result.purchase_price_capture) result.purchase_price_capture.records += page.purchase_price_captures || 0;
          if (result.sales_price_capture) result.sales_price_capture.records += page.sales_price_captures || 0;
          if(page.resource==='stock_balances'){
            result.stock_balances??={batches:0,requested:0,returned:0,unavailable:0,overlaps:0,coverage_complete:false};
            const stock=result.stock_balances;stock.batches++;stock.requested+=page.requested;stock.returned+=page.records;stock.unavailable+=page.unavailable;stock.overlaps+=page.overlaps;
          }
        }
      } catch (error) {
        result.errors.push({ resource: resource.id, code: safeError(error) });
        if([401,403,429].includes(error.status)||error.databaseReleaseUnconfirmed||safeError(error).startsWith('DATABASE_'))tailBlocked=true;
        if ([401,429].includes(error.status)||error.status===403&&!resource.extra) break;
      } finally {
        index = (index + 1) % resources.length;
      }
    }
    if(residualEnabled){
      const phases=[result.xml,result.finance_refresh,result.reference_fetch,result.price_refresh,result.sales_price_refresh,result.migration_sweep,result.sales_history_continuation].filter(Boolean);
      tailBlocked ||= examinations.stopped || phases.some(phase=>phase.stop_json||phase.errors.some(error=>/^(?:ORIGIN_HTTP_(?:401|403|429)|ORIGIN_UNAUTHORIZED|ORIGIN_FORBIDDEN|ORIGIN_RATE_LIMITED)$/.test(error.code)));
      const skip=tailBlocked?'skipped_stopped':client.remainingRequests<3?'skipped_budget':clock()+5000>=workDeadline?'skipped_time':null;
      if(skip)result.xml_residual={status:skip,keys:0,files:0,unchanged:0,requests:0,errors:[],stop_json:false};
      else{
        const before=client.requestsMade;
        try{result.xml_residual=await xmlCollector(repo,client,{owner,lease,deadline:workDeadline,heartbeat,now:clock,
          maxCandidates:4,maxRequests:Math.min(12,client.remainingRequests),examinations,
          ...(xmlPriorityOnly||xmlPriority?.summary().remaining>0?{candidateProvider:xmlPriority.candidateProvider}:{})});}
        catch(error){result.xml_residual={status:'failed',keys:0,files:0,unchanged:0,requests:client.requestsMade-before,errors:[{code:safeError(error)}],stop_json:[401,429].includes(error.status)};}
        const tail=result.xml_residual;
        for(const field of ['keys','files','unchanged','requests'])result.xml[field]+=tail[field];
        result.xml.errors.push(...tail.errors);result.xml.stop_json ||= tail.stop_json;
        if(result.xml.errors.length){result.xml.status='partial';if(!result.errors.some(error=>error.resource==='fiscal_xml'))result.errors.push({resource:'fiscal_xml',code:'XML_COLLECTION_PARTIAL'});}
      }
    }
    result.requests = client.requestsMade;
    if (result.errors.length) result.status = 'partial';
  } catch (error) {
    result.status = 'failed';
    result.errors.push({ code: safeError(error) });
  }
  // Still under the scheduler lease, with ten seconds left for checkpoint/release.
  // Upstream failure does not prevent already-staged versions from being projected.
  if (stockMirrorEnabled) {
    try {
      result.stock_mirror = await projectStockMirror(repo, { deadline: Math.min(deadline - 10000, clock() + 10000), clock });
      if (result.stock_mirror.failed) result.errors.push({ resource: 'stock_mirror', code: 'STOCK_MIRROR_PARTIAL' });
    } catch (error) {
      result.stock_mirror = { status: 'failed', code: safeError(error) };
      result.errors.push({ resource: 'stock_mirror', code: safeError(error) });
    }
    if (result.errors.length && result.status === 'completed') result.status = 'partial';
  }
  if (xmlPriority) {
    result.xml_priority = xmlPriority.summary();
    if (result.xml_priority.residuals) {
      result.errors.push({resource:'xml_priority',code:'XML_PRIORITY_RESIDUAL'});
      if (result.status === 'completed') result.status = 'partial';
    }
  }
  try {
    await repo.apply('__scheduler__', 'control', owner, lease, [], {
      ...previous,
      ...(migrationState ? {migration_sweep:migrationState} : {}),
      ...(xmlPriority ? {xml_priority:xmlPriority.checkpoint()} : {}),
      ...(historyState ? {sales_history_continuation:historyState} : {}),
      nextIndex: index, lastRun: { ...result, finishedAt: now().toISOString() },
    }, boundedCycle ? {deadline:deadline-5000} : undefined);
  } finally {
    await repo.release('__scheduler__', owner, lease.lease_token, boundedCycle ? {deadline} : undefined);
  }
  return result;
}
