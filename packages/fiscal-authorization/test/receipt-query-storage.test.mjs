import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createReceiptQueryStorage} from '../src/receipt-query-storage.mjs';
const projectUrl='https://abcdefghijklmnopqrst.supabase.co',serviceKey='synthetic-service-key-for-local-tests',sha=x=>createHash('sha256').update(x).digest('hex');
const bytes=Buffer.from('<synthetic/>'),tag=sha(bytes),q=randomUUID();
const ref=(kind,hash=tag)=>({bucket:'brufap-fiscal-artifacts',key:`receipt-queries/${q}/${kind}/${hash}.${kind==='observations'?'json':'xml'}`,deadline:Date.now()+5000});
const error=(code,status=404)=>new Response(JSON.stringify({code}),{status,headers:{'content-type':'application/json'}});
const data=(b=bytes)=>new Response(b,{headers:{'content-type':'application/octet-stream','content-length':String(b.length)}});
const port=fetchImpl=>createReceiptQueryStorage({projectUrl,serviceKey,fetchImpl});
const put=(kind,hash=tag)=>({...ref(kind,hash),bytes,sha256:tag,contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*'});
test('089 exact prefix and extensions: no writes or reads of original ledgers or traversal',async()=>{
 let calls=0;const p=port(async()=>{calls++;return data();});
 for(const key of [`authorization/${q}/requests/${tag}.xml`,`revalidations/${q}/${tag}/processed/${tag}.xml`,`candidates/${q}/${tag}.xml`,`receipt-queries/${q}/../requests/${tag}.xml`,`receipt-queries/${q}/observations/${tag}.xml`,`receipt-queries/${q}/responses/${tag}.json`])await assert.rejects(p.read({...ref('requests'),key}),/RECEIPT_QUERY_STORAGE_INPUT_INVALID/);
 assert.equal(calls,0);
});
test('requests/processed bind basename SHA; responses/observations bind supplied content SHA independently',async()=>{
 const seen=[],p=port(async(url,options)=>{seen.push({url,options,copy:Buffer.from(options.body??[])});return options.method==='POST'?new Response('{}',{status:201,headers:{'content-type':'application/json'}}):data();});
 for(const kind of ['requests','processed']){await assert.rejects(p.putImmutable(put(kind,'a'.repeat(64))),/HASH_CONFLICT/);await assert.rejects(p.read(ref(kind,'a'.repeat(64))),/HASH_CONFLICT/);}
 for(const kind of ['requests','processed','responses','observations']){const input=put(kind,['responses','observations'].includes(kind)?'a'.repeat(64):tag);const ack=await p.putImmutable(input);assert.deepEqual(ack,{status:201,requires_readback:true});const row=seen.at(-1);assert.equal(row.options.headers['x-upsert'],'false');assert.equal(row.options.headers['If-None-Match'],'*');assert.deepEqual(row.copy,bytes);assert.ok(row.options.body.every(x=>x===0));assert.deepEqual(Buffer.from(await(await p.read(ref(kind,input.key.split('/').at(-1).split('.')[0]))).arrayBuffer()),bytes);}
 assert.deepEqual(bytes,Buffer.from('<synthetic/>'));
});
test('structured duplicate requires readback; only exact NoSuchKey is absence',async()=>{
 for(const code of ['ResourceAlreadyExists','KeyAlreadyExists','already_exists'])assert.deepEqual(await port(async()=>error(code,409)).putImmutable(put('responses')),{status:409,requires_readback:true});
 assert.equal(await port(async()=>error('NoSuchKey')).read(ref('responses')),null);
 for(const code of ['AccessDenied','BucketNotFound','unknown'])await assert.rejects(port(async()=>error(code)).read(ref('responses')),/HTTP_REJECTED/);
});
test('capture before await, getters refused, abort disposes late response without awaiting cancellation',async()=>{
 let calls=0;const malformed={...ref('responses')};Object.defineProperty(malformed,'key',{get(){calls++;return'';}});await assert.rejects(port(async()=>{calls++;}).read(malformed));assert.equal(calls,0);
 let release,entered;const gate=new Promise(r=>{release=r;}),seen=new Promise(r=>{entered=r;}),abort=new AbortController();let cancel=0;
 const p=port(async()=>{entered();await gate;return new Response(new ReadableStream({cancel(){cancel++;return new Promise(()=>{});}}),{headers:{'content-type':'application/octet-stream'}});});
 const pending=p.read({...ref('responses'),signal:abort.signal});await seen;abort.abort();await assert.rejects(pending,/ABORTED/);release();await new Promise(r=>setImmediate(r));assert.equal(cancel,1);
});
test('bounded bytes, MIME, redirects and empty chunks are rejected',async()=>{
 for(const response of [new Response(bytes,{status:302,headers:{location:'https://invalid.test'}}),new Response(bytes,{headers:{'content-type':'text/plain'}}),data(Buffer.alloc(512001)),new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array());c.close();}}),{headers:{'content-type':'application/octet-stream'}})])await assert.rejects(port(async()=>response).read(ref('responses')));
 await assert.rejects(port(async()=>data(Buffer.alloc(8193))).read(ref('observations')),/BODY_INVALID/);
});
