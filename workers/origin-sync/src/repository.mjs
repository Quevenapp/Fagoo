import { isConfiguredBackendOrigin } from '../../../packages/backend-config/src/origin.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const HISTORY_RPCS = new Set(['get', 'prepare', 'apply', 'inventory'].map(name => `erp_origin_sales_history_continuation_${name}`));
async function boundedJson(response,signal,deadline){
 if(!response.body||Number(response.headers.get('content-length'))>1048576)throw new Error('DATABASE_RESPONSE_SIZE_LIMIT');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
 let abort;
 const cancelled=new Promise((_,reject)=>{abort=()=>reject(new Error('DATABASE_TIMEOUT'));signal.addEventListener('abort',abort,{once:true});});
 const check=()=>{if(signal.aborted)throw new Error('DATABASE_TIMEOUT');if(Date.now()>=deadline)throw new Error('DATABASE_TIME_BUDGET');};
 try{for(;;){check();const{done,value}=await Promise.race([reader.read(),cancelled]);check();if(done)break;
  if(!(value instanceof Uint8Array)||!value.byteLength)throw new Error('DATABASE_INVALID_RESPONSE');
  size+=value.byteLength;if(size>1048576)throw new Error('DATABASE_RESPONSE_SIZE_LIMIT');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
 catch(error){if(/^DATABASE_(?:RESPONSE_SIZE_LIMIT|TIMEOUT|TIME_BUDGET)$/.test(error.message))throw error;throw new Error('DATABASE_INVALID_RESPONSE');}
 finally{signal.removeEventListener('abort',abort);try{void reader.cancel().catch(()=>{});}catch{}try{reader.releaseLock();}catch{}}
}

export class Repository {
  constructor(env, { fetchImpl = fetch, sleep = pause, timeoutMs = 15000 } = {}) {
    const url = new URL(env.SUPABASE_URL);
    if (!isConfiguredBackendOrigin(env.SUPABASE_URL, env.SUPABASE_DEPLOYMENT, { allowTrailingSlash: true, legacyHosted: true })) {
      throw new Error('INVALID_SUPABASE_URL');
    }
    if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_NOT_CONFIGURED');
    this.base = url.origin;
    this.key = env.SUPABASE_SERVICE_ROLE_KEY;
    this.fetch = fetchImpl.bind(globalThis);
    this.sleep = sleep;
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw new Error('INVALID_DATABASE_TIMEOUT');
    this.timeoutMs=timeoutMs;
  }

  async rpc(name, body = {}, { deadline = Infinity } = {}) {
    if (!/^origin_sync_[a-z_]+$/.test(name) && !HISTORY_RPCS.has(name) && name !== 'erp_stock_mirror_project') throw new Error('INVALID_RPC');
    if(typeof deadline!=='number'||Number.isNaN(deadline)||deadline<=0)throw new Error('INVALID_DATABASE_DEADLINE');
    // Capture once, including exact JSON price tokens, before any fetch/await/retry.
    const requestBody = JSON.stringify(body);
    const retrySafe = !['origin_sync_consume_oauth_state', 'origin_sync_create_oauth_state', 'origin_sync_put_credentials'].includes(name);
    for (let attempt = 0; attempt < 3; attempt++) {
      if(Date.now()>=deadline)throw new Error('DATABASE_TIME_BUDGET');
      const controller = new AbortController();
      let timer;
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('DATABASE_TIMEOUT'));},Math.min(this.timeoutMs,Math.max(1,deadline-Date.now())));});
      try {
        const result=await Promise.race([(async()=>{
        const response = await this.fetch(`${this.base}/rest/v1/rpc/${name}`, {
          method: 'POST', redirect: 'manual', signal: controller.signal,
          headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
          body: requestBody,
        });
        if(controller.signal.aborted||Date.now()>=deadline){void response.body?.cancel().catch(()=>{});throw new Error('DATABASE_TIME_BUDGET');}
        if(response.redirected||(response.status>=300&&response.status<400)){await response.body?.cancel();throw new Error('DATABASE_REDIRECT_BLOCKED');}
        if(response.ok)return{value:await boundedJson(response,controller.signal,deadline)};
        await response.body?.cancel();return{status:response.status};
        })(),timeout]);
        if(Object.hasOwn(result,'value'))return result.value;
        if(retrySafe&&(result.status===429||result.status>=500)&&attempt<2){if(Date.now()+250*2**attempt>=deadline)throw new Error('DATABASE_TIME_BUDGET');await this.sleep(250*2**attempt);continue;}
        throw new Error(`DATABASE_HTTP_${result.status}`);
      } catch(error) {
        if(/^DATABASE_(?:HTTP_|REDIRECT_|INVALID_RESPONSE|RESPONSE_SIZE_LIMIT|TIME_BUDGET)/.test(error.message))throw error;
        // A consumed OAuth state cannot be replayed. Reauthorization recovers an uncertain callback.
        if (!retrySafe) throw new Error('DATABASE_UNCERTAIN_RESULT');
        if (attempt === 2) throw new Error('DATABASE_UNAVAILABLE');
        if(Date.now()+250*2**attempt>=deadline)throw new Error('DATABASE_TIME_BUDGET');
        await this.sleep(250 * 2 ** attempt);
        continue;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
  }

  claim(resource, owner, ttl = 600, options) {
    return this.rpc('origin_sync_claim', { p_resource: resource, p_owner: owner, p_ttl_seconds: ttl }, options);
  }
  renew(resource, owner, token, ttl = 600, options) {
    return this.rpc('origin_sync_renew', { p_resource: resource, p_owner: owner, p_lease_token: token, p_ttl_seconds: ttl }, options);
  }
  release(resource, owner, token, options) {
    return this.rpc('origin_sync_release', { p_resource: resource, p_owner: owner, p_lease_token: token }, options);
  }
  apply(resource, entity, owner, lease, records, checkpoint, options) {
    // Generate once: rpc retries send exactly the same batch and checkpoint.
    const precise = records.some(record => Object.hasOwn(record, 'price_capture'));
    return this.rpc(precise ? (entity === 'sales_orders' ? 'origin_sync_apply_sales_price_batch' : entity === 'purchase_orders' ? 'origin_sync_apply_purchase_price_batch' : 'origin_sync_apply_price_batch') : 'origin_sync_apply_batch', {
      p_resource: resource, p_entity: entity, p_owner: owner,
      p_lease_token: lease.lease_token, p_batch_id: crypto.randomUUID(),
      p_records: records, p_checkpoint: checkpoint,
      p_expected_checkpoint_version: lease.checkpoint_version,
    }, options);
  }
  credentials() { return this.rpc('origin_sync_get_credentials'); }
}
