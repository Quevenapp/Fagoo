import {randomBytes,randomUUID,createCipheriv,createDecipheriv,createHash,createHmac,hkdfSync} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {lookup as lookupDns} from 'node:dns/promises';
import {isIP} from 'node:net';
import https from 'node:https';
import {isAdmin} from './auth.mjs';

const error=(message,status=400)=>Object.assign(new Error(message),{status});
const admin=actor=>{if(!isAdmin(actor))throw error('ADMIN_REQUIRED',403);};
const id=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const selected='id,name,url,event_types,start_sequence,active,created_at';
const keyFor=config=>hkdfSync('sha256',Buffer.from(config.secret),Buffer.from('fagoo-webhooks-v1'),Buffer.from('subscription-secrets'),32);

export function encryptWebhookSecret(secret,config,companyId,subscriptionId){
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyFor(config),nonce);cipher.setAAD(Buffer.from(`${companyId}:${subscriptionId}`));
 const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
 return ['v1',nonce.toString('base64url'),ciphertext.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
}
export function decryptWebhookSecret(value,config,companyId,subscriptionId){
 const [version,nonce,encrypted,tag,extra]=value.split('.');if(version!=='v1'||!nonce||!encrypted||!tag||extra)throw error('INVALID_ENCRYPTED_SECRET',500);
 const decipher=createDecipheriv('aes-256-gcm',keyFor(config),Buffer.from(nonce,'base64url'));decipher.setAAD(Buffer.from(`${companyId}:${subscriptionId}`));decipher.setAuthTag(Buffer.from(tag,'base64url'));
 return Buffer.concat([decipher.update(Buffer.from(encrypted,'base64url')),decipher.final()]).toString('utf8');
}
export function webhookUrl(value){
 let url;try{url=new URL(value);}catch{throw error('INVALID_WEBHOOK_URL');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||!url.hostname.includes('.')||isIP(url.hostname.replace(/^\[|\]$/g,''))||/(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)||(url.port&&url.port!=='443')||url.href.length>2000)throw error('INVALID_WEBHOOK_URL');
 return url.href;
}
export function publicAddress(address){
 if(isIP(address)===4){const[a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&[0,168].includes(b)||a===100&&b>=64&&b<=127||a===198&&[18,19].includes(b)||a===198&&b===51&&c===100||a===203&&b===0&&c===113);}
 if(isIP(address)===6){const normalized=address.toLowerCase(),first=parseInt(normalized.split(':')[0]||'0',16);return first>=0x2000&&first<=0x3fff&&!normalized.startsWith('2001:db8:')&&!normalized.startsWith('2001:0:')&&!normalized.startsWith('2001::')&&!normalized.startsWith('2002:');}
 return false;
}
export async function deliverPublicWebhook(urlValue,options,resolver=lookupDns){
 const url=new URL(webhookUrl(urlValue));options.signal?.throwIfAborted();
 const resolution=resolver(url.hostname,{all:true,verbatim:true});
 const addresses=await(options.signal?Promise.race([resolution,new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(error('DELIVERY_TIMEOUT')),{once:true}))]):resolution);
 if(!addresses.length||addresses.some(row=>!publicAddress(row.address)))throw error('WEBHOOK_DESTINATION_BLOCKED');
 const selectedAddress=addresses[0];
 return new Promise((resolve,reject)=>{
  const request=https.request(url,{method:'POST',headers:options.headers,signal:options.signal,agent:false,
   lookup:(_hostname,lookupOptions,callback)=>lookupOptions.all?callback(null,[selectedAddress]):callback(null,selectedAddress.address,selectedAddress.family)},response=>{
    let bytes=0;response.on('data',data=>{bytes+=data.length;if(bytes>65536)response.destroy(error('WEBHOOK_RESPONSE_TOO_LARGE'));});response.on('error',reject);
    response.on('end',()=>resolve({status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300}));
   });request.on('error',reject);request.end(options.body);
 });
}
async function transaction(pool,run){const client=await pool.connect();try{await client.query('BEGIN');const result=await run(client);await client.query('COMMIT');return result;}catch(failure){await client.query('ROLLBACK').catch(()=>{});throw failure;}finally{client.release();}}
export async function migrateWebhooks(pool){
 const sql=await readFile(new URL('../sql/webhooks.sql',import.meta.url),'utf8'),hash=createHash('sha256').update(sql).digest('hex');
 await transaction(pool,async client=>{await client.query('LOCK TABLE fagoo.schema_migration IN EXCLUSIVE MODE');
  const old=(await client.query('SELECT sha256 FROM fagoo.schema_migration WHERE name=$1',['system_webhooks_v1'])).rows[0];
  if(old){if(old.sha256!==hash)throw error('WEBHOOK_MIGRATION_CHECKSUM_CHANGED',500);return;}
  if(client.exec)await client.exec(sql);else await client.query(sql);
  await client.query('INSERT INTO fagoo.schema_migration(name,sha256) VALUES($1,$2)',['system_webhooks_v1',hash]);
 });
}
export async function createWebhookSubscription(pool,config,actor,input){
 admin(actor);if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>120||!Array.isArray(input.event_types)||!input.event_types.length||input.event_types.length>30||input.event_types.some(type=>typeof type!=='string'||!/^(?:\*|[a-z][a-z0-9_.-]{1,100})$/.test(type)))throw error('INVALID_WEBHOOK');
 const url=webhookUrl(input.url),subscriptionId=randomUUID(),secret=randomBytes(32).toString('hex');
 return transaction(pool,async client=>{
  await client.query('SELECT id FROM fagoo.company WHERE id=$1 FOR UPDATE',[actor.companyId]);
  const count=(await client.query('SELECT count(*)::integer n FROM fagoo.webhook_subscription WHERE company_id=$1 AND active',[actor.companyId])).rows[0].n;if(count>=20)throw error('WEBHOOK_LIMIT_REACHED');
  const high=(await client.query('SELECT coalesce(max(sequence),0)::text sequence FROM fagoo.event WHERE company_id=$1',[actor.companyId])).rows[0].sequence,from=input.from_sequence??high;
  if(typeof from!=='string'||!/^(0|[1-9]\d{0,18})$/.test(from)||BigInt(from)>BigInt(high))throw error('INVALID_START_SEQUENCE');
  const result=await client.query(`INSERT INTO fagoo.webhook_subscription(id,company_id,name,url,event_types,secret_ciphertext,start_sequence,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${selected}`,[subscriptionId,actor.companyId,input.name.trim(),url,[...new Set(input.event_types)],encryptWebhookSecret(secret,config,actor.companyId,subscriptionId),from,actor.id]);
  await client.query('INSERT INTO fagoo.security_audit(company_id,actor_id,action,target) VALUES($1,$2,$3,$4)',[actor.companyId,actor.id,'webhook.create',subscriptionId]);return{...result.rows[0],secret};
 });
}
export async function listWebhookSubscriptions(pool,actor){admin(actor);return{items:(await pool.query(`SELECT ${selected} FROM fagoo.webhook_subscription WHERE company_id=$1 ORDER BY created_at DESC`,[actor.companyId])).rows};}
export async function disableWebhookSubscription(pool,actor,subscriptionId){
 admin(actor);if(!id(subscriptionId))throw error('INVALID_ID');
 return transaction(pool,async client=>{const result=await client.query('UPDATE fagoo.webhook_subscription SET active=false WHERE company_id=$1 AND id=$2 RETURNING id',[actor.companyId,subscriptionId]);if(!result.rows.length)throw error('NOT_FOUND',404);
  await client.query("UPDATE fagoo.webhook_delivery SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE subscription_id=$1 AND state IN ('pending','processing')",[subscriptionId]);
  await client.query('INSERT INTO fagoo.security_audit(company_id,actor_id,action,target) VALUES($1,$2,$3,$4)',[actor.companyId,actor.id,'webhook.disable',subscriptionId]);return{id:subscriptionId,active:false};
 });
}
export async function listWebhookDeliveries(pool,actor,subscriptionId,{before=null,limit=50}={}){
 admin(actor);if(!id(subscriptionId)||!Number.isInteger(limit)||limit<1||limit>100||(before!==null&&(typeof before!=='string'||!/^(0|[1-9]\d{0,18})$/.test(before))))throw error('INVALID_DELIVERY_QUERY');
 const exists=(await pool.query('SELECT id FROM fagoo.webhook_subscription WHERE id=$1 AND company_id=$2',[subscriptionId,actor.companyId])).rows[0];if(!exists)throw error('NOT_FOUND',404);
 const rows=(await pool.query('SELECT id,event_sequence::text,state,attempts,available_at,last_status,last_error,delivered_at FROM fagoo.webhook_delivery WHERE subscription_id=$1 AND company_id=$2 AND ($3::bigint IS NULL OR event_sequence<$3::bigint) ORDER BY event_sequence DESC LIMIT $4',[subscriptionId,actor.companyId,before,limit+1])).rows;
 const has_more=rows.length>limit,items=rows.slice(0,limit);return{items,has_more,next_cursor:has_more?items.at(-1).event_sequence:null};
}
export async function retryWebhookDelivery(pool,actor,deliveryId){
 admin(actor);if(!id(deliveryId))throw error('INVALID_ID');
 return transaction(pool,async client=>{const result=await client.query("UPDATE fagoo.webhook_delivery d SET state='pending',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL FROM fagoo.webhook_subscription s WHERE d.id=$1 AND d.company_id=$2 AND s.id=d.subscription_id AND s.active AND d.state='dead' RETURNING d.id",[deliveryId,actor.companyId]);if(!result.rows.length)throw error('DELIVERY_NOT_RETRYABLE',409);
  await client.query('INSERT INTO fagoo.security_audit(company_id,actor_id,action,target) VALUES($1,$2,$3,$4)',[actor.companyId,actor.id,'webhook.retry',deliveryId]);return{id:deliveryId,state:'pending'};
 });
}
export async function enqueueWebhookEvents(pool){
 return transaction(pool,async client=>{const subscriptions=(await client.query('SELECT * FROM fagoo.webhook_subscription WHERE active ORDER BY last_scanned_at NULLS FIRST,created_at FOR UPDATE SKIP LOCKED LIMIT 20')).rows;let enqueued=0;
  for(const subscription of subscriptions){
   // Select missing deliveries, not a moving cursor: late commits are still found.
   const events=(await client.query("SELECT e.* FROM fagoo.event e WHERE e.company_id=$1 AND e.sequence>$2 AND ('*'=ANY($3::text[]) OR e.type=ANY($3::text[])) AND NOT EXISTS(SELECT 1 FROM fagoo.webhook_delivery d WHERE d.subscription_id=$4 AND d.event_sequence=e.sequence) ORDER BY e.sequence LIMIT 100",[subscription.company_id,subscription.start_sequence,subscription.event_types,subscription.id])).rows;
   for(const event of events){const deliveryId=randomUUID(),body={id:deliveryId,event_id:String(event.sequence),company_id:event.company_id,type:event.type,resource_id:event.resource_id,payload:event.payload,occurred_at:event.created_at};
    await client.query('INSERT INTO fagoo.webhook_delivery(id,subscription_id,company_id,event_sequence,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(subscription_id,event_sequence) DO NOTHING',[deliveryId,subscription.id,subscription.company_id,event.sequence,JSON.stringify(body)]);enqueued++;}
   await client.query('UPDATE fagoo.webhook_subscription SET last_scanned_at=now() WHERE id=$1',[subscription.id]);
  }return enqueued;
 });
}
export async function dispatchWebhookBatch(pool,config,{fetchImpl=deliverPublicWebhook,limit=5,timeoutMs=8000}={}){
 if(!Number.isInteger(limit)||limit<1||limit>10||timeoutMs<10||timeoutMs>8000)throw error('INVALID_DISPATCH_LIMIT');
 const lease=randomUUID(),enqueued=await enqueueWebhookEvents(pool);
 const claims=(await pool.query("WITH candidates AS(SELECT d.id FROM fagoo.webhook_delivery d JOIN fagoo.webhook_subscription s ON s.id=d.subscription_id WHERE s.active AND ((d.state='pending' AND d.available_at<=now()) OR(d.state='processing' AND d.lease_until<now())) ORDER BY d.available_at,d.event_sequence FOR UPDATE OF d SKIP LOCKED LIMIT $1) UPDATE fagoo.webhook_delivery d SET state='processing',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '120 seconds' FROM candidates c WHERE d.id=c.id RETURNING d.*",[limit,lease])).rows;
 const stats={enqueued,claimed:claims.length,delivered:0,retried:0,dead:0};
 for(const delivery of claims){
  const subscription=(await pool.query('SELECT * FROM fagoo.webhook_subscription WHERE id=$1 AND company_id=$2 AND active',[delivery.subscription_id,delivery.company_id])).rows[0];if(!subscription)continue;
  let status=null,reason='DELIVERY_FAILED',success=false;
  try{const secret=decryptWebhookSecret(subscription.secret_ciphertext,config,subscription.company_id,subscription.id),body=JSON.stringify(delivery.body);if(Buffer.byteLength(body)>262144)throw error('WEBHOOK_PAYLOAD_TOO_LARGE');
   const timestamp=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex');
   const response=await fetchImpl(subscription.url,{method:'POST',redirect:'error',body,signal:AbortSignal.timeout(timeoutMs),headers:{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body)),'X-Fagoo-Delivery-Id':delivery.id,'X-Fagoo-Event-Id':String(delivery.event_sequence),'X-Fagoo-Timestamp':timestamp,'X-Fagoo-Signature':'v1='+signature}});
   status=response.status;success=status>=200&&status<300;reason=`HTTP_${status}`;
  }catch(failure){reason=['WEBHOOK_DESTINATION_BLOCKED','WEBHOOK_PAYLOAD_TOO_LARGE'].includes(failure.message)?failure.message:'DELIVERY_FAILED';}
  const state=success?'delivered':delivery.attempts>=8?'dead':'pending',delay=Math.min(3600,30*2**Math.min(delivery.attempts-1,7));
  await pool.query("UPDATE fagoo.webhook_delivery SET state=$1,last_status=$2,last_error=$3,lease_token=NULL,lease_until=NULL,delivered_at=CASE WHEN $1='delivered' THEN now() ELSE delivered_at END,available_at=now()+($4::integer*interval '1 second') WHERE id=$5 AND lease_token=$6 AND state='processing'",[state,status,success?null:reason,delay,delivery.id,lease]);
  stats[success?'delivered':state==='dead'?'dead':'retried']++;
 }return stats;
}
