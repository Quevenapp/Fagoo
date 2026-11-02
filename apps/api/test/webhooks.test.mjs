import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../packages/database/migrate.mjs';
import {migrateWebhooks,createWebhookSubscription,listWebhookSubscriptions,disableWebhookSubscription,listWebhookDeliveries,retryWebhookDelivery,enqueueWebhookEvents,dispatchWebhookBatch,encryptWebhookSecret,decryptWebhookSecret,webhookUrl,publicAddress,deliverPublicWebhook} from '../src/webhook-delivery.mjs';

let db,pool,actor,other;const config={secret:'test-only-authentication-key-with-more-than-32-characters'};
before(async()=>{
 if(process.env.WEBHOOK_TEST_DATABASE_URL){const url=new URL(process.env.WEBHOOK_TEST_DATABASE_URL);assert(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname.endsWith('_test'),'Only an explicit local test database may be reset');const{Pool}=await import('pg');pool=new Pool({connectionString:url.href,max:5});await migrate(pool);await pool.query(await readFile(new URL('../sql/system.sql',import.meta.url),'utf8'));await migrateWebhooks(pool);await migrateWebhooks(pool);return;}
 db=new PGlite();let pending=Promise.resolve();pool={query:(...args)=>db.query(...args),async connect(){const previous=pending;let unlock;pending=new Promise(resolve=>{unlock=resolve;});await previous;return{query:(...args)=>db.query(...args),exec:(...args)=>db.exec(...args),release:unlock};}};
 await migrate(pool);await db.exec(await readFile(new URL('../sql/system.sql',import.meta.url),'utf8'));await migrateWebhooks(pool);await migrateWebhooks(pool);
});
after(async()=>{await db?.close();await pool?.end?.();});
beforeEach(async()=>{
 await pool.query('TRUNCATE fagoo.company CASCADE');actor={id:'admin',companyId:randomUUID(),kind:'user',scopes:['*']};other={...actor,id:'other-admin',companyId:randomUUID()};
 for(const a of[actor,other])await pool.query('INSERT INTO fagoo.company(id,name) VALUES($1,$2)',[a.companyId,'Empresa de teste']);
});
const subscription=(a=actor,extra={})=>createWebhookSubscription(pool,config,a,{name:'Atendimento',url:'https://hooks.example.com/fagoo',event_types:['*'],...extra});
const event=(a=actor,type='stock.received')=>pool.query('INSERT INTO fagoo.event(company_id,type,resource_id,payload) VALUES($1,$2,$3,$4) RETURNING sequence',[a.companyId,type,randomUUID(),JSON.stringify({quantity:'12.000000'})]);

test('subscription secrets are encrypted, scoped and returned only at creation',async()=>{
 const created=await subscription(),stored=(await pool.query('SELECT secret_ciphertext FROM fagoo.webhook_subscription WHERE id=$1',[created.id])).rows[0].secret_ciphertext;
 assert(!stored.includes(created.secret));assert.equal(decryptWebhookSecret(stored,config,actor.companyId,created.id),created.secret);
 assert.throws(()=>decryptWebhookSecret(stored,config,other.companyId,created.id));
 const listed=await listWebhookSubscriptions(pool,actor);assert.equal(listed.items.length,1);assert(!('secret' in listed.items[0]));assert(!('secret_ciphertext' in listed.items[0]));
 assert.equal((await listWebhookSubscriptions(pool,other)).items.length,0);
 await assert.rejects(disableWebhookSubscription(pool,other,created.id),/NOT_FOUND/);
 await assert.rejects(subscription({...actor,kind:'integration'}),/ADMIN_REQUIRED/);
});
test('no configured subscription causes no outbound calls',async()=>{
 await event();let calls=0;const result=await dispatchWebhookBatch(pool,config,{fetchImpl:async()=>{calls++;return{status:200};}});
 assert.equal(calls,0);assert.equal(result.claimed,0);
});
test('event delivery is tenant-scoped, signed and not duplicated by repeated scans',async()=>{
 const created=await subscription(actor,{event_types:['stock.received']});await event();await event(other);await event(actor,'order.created');const calls=[];
 const fetchImpl=async(url,options)=>{calls.push({url,...options});return{status:200};};
 assert.equal((await dispatchWebhookBatch(pool,config,{fetchImpl})).delivered,1);
 assert.equal((await dispatchWebhookBatch(pool,config,{fetchImpl})).claimed,0);assert.equal(calls.length,1);
 const call=calls[0],payload=JSON.parse(call.body);assert.equal(payload.company_id,actor.companyId);
 const expected=createHmac('sha256',created.secret).update(call.headers['X-Fagoo-Timestamp']+'.'+call.body).digest('hex');assert.equal(call.headers['X-Fagoo-Signature'],'v1='+expected);
 assert.equal((await pool.query('SELECT count(*)::integer n FROM fagoo.webhook_delivery')).rows[0].n,1);
});
test('failed delivery waits for backoff and retries with the same id',async()=>{
 await subscription();await event();const calls=[];const fail=async(_,options)=>{calls.push(options.headers['X-Fagoo-Delivery-Id']);return{status:503};};
 assert.equal((await dispatchWebhookBatch(pool,config,{fetchImpl:fail})).retried,1);
 assert.equal((await dispatchWebhookBatch(pool,config,{fetchImpl:fail})).claimed,0);
 await pool.query("UPDATE fagoo.webhook_delivery SET available_at=now()-interval '1 second'");
 const success=async(_,options)=>{calls.push(options.headers['X-Fagoo-Delivery-Id']);return{status:204};};
 assert.equal((await dispatchWebhookBatch(pool,config,{fetchImpl:success})).delivered,1);assert.equal(calls[0],calls[1]);
});
test('concurrent workers claim different deliveries',async()=>{
 await subscription();await event();await event();await enqueueWebhookEvents(pool);const deliveries=[];
 const fetchImpl=async(_,options)=>{deliveries.push(options.headers['X-Fagoo-Delivery-Id']);await new Promise(resolve=>setTimeout(resolve,10));return{status:200};};
 const results=await Promise.all([dispatchWebhookBatch(pool,config,{fetchImpl,limit:1}),dispatchWebhookBatch(pool,config,{fetchImpl,limit:1})]);
 assert.equal(results.reduce((sum,result)=>sum+result.delivered,0),2);assert.equal(new Set(deliveries).size,2);
});
test('expired processing leases resume after restart; disabled subscriptions stop queued work',async()=>{
 const created=await subscription();await event();await enqueueWebhookEvents(pool);
 await pool.query("UPDATE fagoo.webhook_delivery SET state='processing',attempts=1,lease_token=$1,lease_until=now()-interval '1 second'",[randomUUID()]);
 assert.equal((await dispatchWebhookBatch(pool,config,{fetchImpl:async()=>({status:200})})).delivered,1);
 await event();await enqueueWebhookEvents(pool);await disableWebhookSubscription(pool,actor,created.id);
 assert.equal((await dispatchWebhookBatch(pool,config,{fetchImpl:async()=>{throw new Error('must not call');}})).claimed,0);
 assert.equal((await pool.query("SELECT count(*)::integer n FROM fagoo.webhook_delivery WHERE state='cancelled'")).rows[0].n,1);
});
test('exhausted deliveries remain inspectable and explicit retry preserves their identity',async()=>{
 const created=await subscription();await event();await enqueueWebhookEvents(pool);
 await pool.query('UPDATE fagoo.webhook_delivery SET attempts=7');
 assert.equal((await dispatchWebhookBatch(pool,config,{fetchImpl:async()=>({status:302})})).dead,1);
 const state=await listWebhookDeliveries(pool,actor,created.id);assert.equal(state.items[0].state,'dead');assert.equal(state.items[0].last_status,302);
 await assert.rejects(listWebhookDeliveries(pool,other,created.id),/NOT_FOUND/);
 const deliveryId=state.items[0].id;await retryWebhookDelivery(pool,actor,deliveryId);
 assert.equal((await dispatchWebhookBatch(pool,config,{fetchImpl:async(_,options)=>{assert.equal(options.headers['X-Fagoo-Delivery-Id'],deliveryId);return{status:200};}})).delivered,1);
});
test('webhook destinations reject private addresses, credentials and unsafe resolution',async()=>{
 for(const url of['http://hooks.example.com','https://127.0.0.1/x','https://test.local/x','https://user:pass@hooks.example.com/x','https://hooks.example.com/x?token=secret'])assert.throws(()=>webhookUrl(url));
 for(const address of['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','fc00::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(publicAddress(address),false,address);
 assert.equal(publicAddress('1.1.1.1'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
 await assert.rejects(deliverPublicWebhook('https://hooks.example.com',{signal:AbortSignal.timeout(1000)},async()=>[{address:'127.0.0.1',family:4}]),/DESTINATION_BLOCKED/);
});
