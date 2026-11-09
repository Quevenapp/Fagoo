import test from 'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{dispatchQueuePush,resetQueuePushCache}from'../src/queues-push.mjs';
const notice=()=>({notice_id:randomUUID(),claim_id:randomUUID(),channel:'push_fcm',destination:'synthetic-device-token',text:'Senha A001, guichê 1.',public_token:'a'.repeat(32),expires_at:new Date(Date.now()+60000).toISOString()});
async function key(algorithm){const pair=await crypto.subtle.generateKey(algorithm==='rsa'?{name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'}:{name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);return '-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----';}
test('FCM sends once after a fresh SQL authority check; provider acceptance and lost response differ',async()=>{
 resetQueuePushCache();const env={FAGOO_QUEUE_FCM_SERVICE_ACCOUNT_JSON:JSON.stringify({project_id:'fagoo-synthetic',client_email:'service@synthetic.test',private_key:await key('rsa')})};let allowed=0,sends=0;
 const rpc=async()=>{allowed++;return true;},fetcher=async(url,options)=>{if(url.includes('oauth2'))return Response.json({access_token:'synthetic-oauth',expires_in:3600});sends++;const b=JSON.parse(options.body);assert.equal(b.message.notification.body,'Senha A001, guichê 1.');assert.equal(b.message.token,'synthetic-device-token');assert.equal(options.redirect,'error');return Response.json({name:'projects/synthetic/messages/1'});};
 assert.equal((await dispatchQueuePush({env,rpc,notice:notice(),fetcher})).status,'sent');assert.equal(allowed,1);assert.equal(sends,1);
 assert.equal((await dispatchQueuePush({env,rpc:async()=>false,notice:notice(),fetcher})).status,'expired');assert.equal(sends,1);
 const lost=await dispatchQueuePush({env,rpc,notice:notice(),fetcher:async()=>{sends++;throw new Error('connection reset');}});assert.equal(lost.status,'unknown');assert.equal(sends,2);
});
test('APNs uses the configured topic/environment and expiry; missing credentials never claim delivery',async()=>{
 resetQueuePushCache();const n={...notice(),channel:'push_apns',destination:'b'.repeat(64)},env={FAGOO_QUEUE_APNS_PRIVATE_KEY:await key('ec'),FAGOO_QUEUE_APNS_KEY_ID:'SYNTHETIC',FAGOO_QUEUE_APNS_TEAM_ID:'SYNTHETIC',FAGOO_QUEUE_APNS_TOPIC:'br.com.synthetic.client',FAGOO_QUEUE_APNS_ENVIRONMENT:'sandbox'};
 const sent=await dispatchQueuePush({env,rpc:async()=>true,notice:n,fetcher:async(url,options)=>{assert(url.startsWith('https://api.sandbox.push.apple.com/3/device/'));assert.equal(options.headers['apns-topic'],'br.com.synthetic.client');assert.equal(options.headers['apns-id'],n.notice_id);return new Response(null,{status:200,headers:{'apns-id':n.notice_id}});}});assert.equal(sent.status,'sent');
 assert.equal((await dispatchQueuePush({env:{},rpc:async()=>true,notice:n,fetcher:()=>assert.fail('no provider request')})).status,'failed');
 assert.equal((await dispatchQueuePush({env,rpc:async()=>true,notice:{...n,expires_at:'2000-01-01T00:00:00Z'},fetcher:()=>assert.fail('expired')})).status,'expired');
});
