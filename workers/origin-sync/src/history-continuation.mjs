/** Only immutable083 observations. Uses durable093 prepares; no Origin GET or native business effects. */
const PROFILE = 'origin-sales-history-continuation-worker-v1';
const PREFIX = 'erp_origin_sales_history_continuation_';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]{0,39}$/;
const stamp = x => typeof x === 'string' && Number.isFinite(Date.parse(x));
const cursor = x => x === null || typeof x === 'string' && x.length >= 1 && x.length <= 200;
const integer = (x,min=0,max=Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(x) && x >= min && x <= max;
const fail = code => {throw new Error(code);};
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value);
const noEffects = x => x && x.native_effects === false && x.fiscal_effects === false && x.coverage_certified === false;

function envelope(value,actor) {
  if (!noEffects(value) || value.profile !== 'origin-sales-history-continuation-state-v1'
    || !UUID.test(value.batch_id) || value.actor !== actor || !HASH.test(value.request_hash) || !HASH.test(value.prepare_hash)
    || !['prepared','pending_existing','applied','rejected','empty'].includes(value.status)
    || !stamp(value.prepared_at) || !stamp(value.expires_at) || Date.parse(value.expires_at)-Date.parse(value.prepared_at)!==600000) fail('HISTORY_ENVELOPE_INVALID');
  const p=value.proof;
  if (!noEffects(p) || p.profile !== 'origin-sales-history-continuation-prepare-v1' || p.batch_id !== value.batch_id
    || p.actor !== actor || !cursor(p.after) || !cursor(p.next_after) || !integer(p.limit,1,25) || !integer(p.scanned,0,100)
    || typeof p.reached_end_of_pass !== 'boolean' || p.prepared_at !== value.prepared_at || p.expires_at !== value.expires_at
    || !Array.isArray(p.items) || p.items.length>p.limit || !Array.isArray(p.residuals) || p.residuals.length>100
    || p.scanned !== p.items.length+p.residuals.length) fail('HISTORY_PROOF_INVALID');
  const identity = x => x && typeof x.source_id === 'string' && x.source_id.length>=1 && x.source_id.length<=200
    && HASH.test(x.source_hash) && typeof x.source_version==='string' && /^[1-9][0-9]{0,18}$/.test(x.source_version)
    && BigInt(x.source_version)<=9223372036854775807n && HASH.test(x.price_capture_hash);
  if (p.items.some(x=>!identity(x)||!ID.test(x.source_id)||x.eligible!==true||!UUID.test(x.command_id)||!HASH.test(x.snapshot_hash))
    || p.residuals.some(x=>!identity(x)||x.eligible!==false||!['sales_history_source_invalid','sales_history_source_too_large','price_capture_not_bound'].includes(x.reason))
    || new Set([...p.items,...p.residuals].map(x=>x.source_id)).size!==p.scanned
    || new Set(p.items.map(x=>x.command_id)).size!==p.items.length) fail('HISTORY_PROOF_INVALID');
  if (!value.terminal) {
    if (!['prepared','pending_existing'].includes(value.status)||!p.items.length) fail('HISTORY_TERMINAL_INVALID');
    return value;
  }
  const t=value.terminal,r=t.result;
  if (!['applied','rejected','empty'].includes(t.status)||value.status!==t.status||!HASH.test(t.result_hash)||!stamp(t.finished_at)
    || !noEffects(r)||r.profile!=='origin-sales-history-continuation-result-v1'||r.batch_id!==value.batch_id
    || r.prepare_hash!==value.prepare_hash||r.status!==t.status||!Array.isArray(r.receipts)||r.captured_count!==r.receipts.length
    || (t.status==='applied' ? !p.items.length||r.receipts.length!==p.items.length||r.reason!==null
      : r.receipts.length!==0||t.status==='empty'&&(p.items.length!==0||r.reason!==null)
        ||t.status==='rejected'&&!['prepared_expired','source_changed','already_captured','command_conflict','source_missing'].includes(r.reason))) fail('HISTORY_TERMINAL_INVALID');
  const receipts=new Map(r.receipts.map(x=>[x?.source?.source_id,x]));
  if (receipts.size!==r.receipts.length) fail('HISTORY_RECEIPT_INVALID');
  if (t.status==='applied') for(const item of p.items) {
    const receipt=receipts.get(item.source_id);
    if (!receipt||receipt.command_id!==item.command_id||receipt.snapshot_hash!==item.snapshot_hash
      || !/^bsh_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.history_id)||!stamp(receipt.captured_at)
      || receipt.source.namespace!=='origin_api'||receipt.source.entity!=='sales_orders'
      || receipt.source.source_hash!==item.source_hash||receipt.source.source_version!==item.source_version
      || !stamp(receipt.source.last_seen_at)) fail('HISTORY_RECEIPT_INVALID');
  }
  return value;
}

export function historyContinuationPolicy(env) {
  if (env.SALES_HISTORY_CONTINUATION_ENABLED!=='true') return null;
  if (!UUID.test(env.SALES_HISTORY_CONTINUATION_ACTOR)) fail('HISTORY_CONFIG_INVALID');
  const maxBatches=Number(env.SALES_HISTORY_CONTINUATION_BATCHES??4);
  if (!integer(maxBatches,1,4)) fail('HISTORY_CONFIG_INVALID');
  return {actor:env.SALES_HISTORY_CONTINUATION_ACTOR,maxBatches};
}

/** A lost prepare/apply/readback ACK leaves a durable batch to recover before a new UUID is used. */
export async function continueSalesHistory(repo,{owner,lease,actor,checkpoint,maxBatches=4,deadline,heartbeat=async()=>{},clock=Date.now}={}) {
  if (!UUID.test(owner)||!UUID.test(lease?.lease_token)||!UUID.test(actor)||!Number.isFinite(deadline)||!integer(maxBatches,1,4)) fail('HISTORY_CONTEXT_INVALID');
  let state=checkpoint===undefined?{profile:PROFILE,actor,after:null,pending:null,passes:0,confirmed_batches:0,captured:0,rejected:0,
    residuals_observed:0,started_at:new Date(clock()).toISOString(),last_confirmed_at:null}:structuredClone(checkpoint);
  if (!state||state.profile!==PROFILE||state.actor!==actor||!cursor(state.after)||!stamp(state.started_at)
    || !['passes','confirmed_batches','captured','rejected','residuals_observed'].every(k=>integer(state[k]))
    || state.last_confirmed_at!==null&&!stamp(state.last_confirmed_at)
    || state.pending!==null&&(!UUID.test(state.pending.batch_id)||!cursor(state.pending.after)||!integer(state.pending.limit,1,25)
      ||state.pending.prepare_hash!==null&&!HASH.test(state.pending.prepare_hash))) fail('HISTORY_CHECKPOINT_INVALID');
  const result={status:'completed',batches:0,captured:0,rejected:0,residuals:0,recovered:0,passes:0,errors:[],
    stop_json:false,stop_residual:false,coverage_complete:false};
  const call=async(name,args={})=>{await heartbeat(deadline);if(clock()+1000>=deadline)fail('HISTORY_TIME_BUDGET');
    return repo.rpc(PREFIX+name,{p_user_id:actor,...args},{deadline});};
  const get=async id=>{
    const found=await call('get',{p_batch_id:id});
    if (found?.profile!=='origin-sales-history-continuation-get-v1'||!Object.hasOwn(found,'batch')) fail('HISTORY_GET_INVALID');
    return found.batch===null?null:envelope(found.batch,actor);
  };
  try {
    for(let step=0;step<maxBatches;step++) {
      if(clock()+10000>=deadline){result.status='skipped_time';break;}
      let saved=await get(state.pending?.batch_id??null);
      if(saved) {
        if(state.pending&&(saved.batch_id!==state.pending.batch_id||state.pending.prepare_hash!==null&&saved.prepare_hash!==state.pending.prepare_hash)) fail('HISTORY_PENDING_CONFLICT');
        result.recovered++;
      } else {
        if(state.pending?.prepare_hash)fail('HISTORY_PREPARE_MISSING');
        state.pending??={batch_id:crypto.randomUUID(),after:state.after,limit:25,prepare_hash:null};
        const request=structuredClone(state.pending);
        saved=envelope(await call('prepare',{p_owner:owner,p_scheduler_token:lease.lease_token,p_batch_id:request.batch_id,
          p_after:request.after,p_limit:request.limit}),actor);
        if(saved.status!=='pending_existing'&&(saved.batch_id!==request.batch_id||saved.proof.after!==request.after||saved.proof.limit!==request.limit))fail('HISTORY_PREPARE_CONFLICT');
      }
      state.pending={batch_id:saved.batch_id,after:saved.proof.after,limit:saved.proof.limit,prepare_hash:saved.prepare_hash};
      const frozen=structuredClone(saved);
      if(!saved.terminal) {
        saved=envelope(await call('apply',{p_owner:owner,p_scheduler_token:lease.lease_token,p_batch_id:saved.batch_id,p_prepare_hash:saved.prepare_hash}),actor);
      }
      if(saved.batch_id!==frozen.batch_id||saved.prepare_hash!==frozen.prepare_hash||canonical(saved.proof)!==canonical(frozen.proof)||!saved.terminal)fail('HISTORY_APPLY_CONFLICT');
      const confirmed=await get(saved.batch_id);
      if(!confirmed||canonical(confirmed)!==canonical(saved))fail('HISTORY_READBACK_CONFLICT');
      result.batches++;result.captured+=saved.terminal.result.captured_count;
      result.rejected+=saved.status==='rejected'?1:0;result.residuals+=saved.proof.residuals.length;
      state.confirmed_batches++;state.captured+=saved.terminal.result.captured_count;state.rejected+=saved.status==='rejected'?1:0;
      state.residuals_observed+=saved.proof.residuals.length;state.pending=null;state.last_confirmed_at=saved.terminal.finished_at;
      state.after=saved.status==='rejected'||saved.proof.reached_end_of_pass?null:saved.proof.next_after;
      if(saved.proof.reached_end_of_pass){state.passes++;result.passes++;}
      if(saved.status==='rejected'||saved.proof.reached_end_of_pass)break;
    }
  }catch(error) {
    result.status='partial';result.stop_json=result.stop_residual=true;
    const code=String(error?.code||error?.message||'');result.errors.push({code:/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'HISTORY_CONTINUATION_FAILED'});
  }
  return {result,checkpoint:structuredClone(state)};
}
