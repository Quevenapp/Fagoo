import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createReconciliationStorage} from '../src/storage.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const bucket='brufap-fiscal-artifacts',projectUrl='https://abcdefghijklmnopqrst.supabase.co',serviceKey='SYNTHETIC_STORAGE_SECRET_062';
const key=()=>`reconciliation/${randomUUID()}/observations/${sha('request')}.json`;
const write=(k,bytes)=>({bucket,key:k,bytes,sha256:sha(bytes),contentType:'application/octet-stream',upsert:false,ifNoneMatch:'*',deadline:Date.now()+1000});
test('operational sidecar is immutable and bounded to 8 KiB on both HTTP directions',async()=>{
 const files=new Map();let calls=0;const port=createReconciliationStorage({projectUrl,serviceKey,fetchImpl:async(url,o)=>{calls++;const path=url.split(bucket+'/')[1];assert.equal(o.redirect,'manual');if(o.method==='GET')return new Response(files.get(path),{headers:{'content-type':'application/octet-stream'}});assert.equal(o.headers['x-upsert'],'false');assert.equal(o.headers['If-None-Match'],'*');if(files.has(path))return Response.json({code:'ResourceAlreadyExists'},{status:409});files.set(path,Buffer.from(o.body));return Response.json({ok:true},{status:201});}});
 const k=key(),bytes=Buffer.alloc(8192,32);bytes[0]=123;bytes[8191]=125;const first=await port.putImmutable(write(k,bytes));assert.deepEqual(first,{status:201,requires_readback:true});assert.notEqual(sha(bytes),k.split('/').at(-1).slice(0,-5));assert.equal((await port.putImmutable(write(k,Buffer.from('{}')))).status,409);const response=await port.read({bucket,key:k,deadline:Date.now()+1000});assert.equal(sha(Buffer.from(await response.arrayBuffer())),sha(bytes));
 const before=calls;await assert.rejects(port.putImmutable(write(key(),Buffer.alloc(8193))),{code:'RECONCILIATION_STORAGE_WRITE_INVALID'});assert.equal(calls,before);files.set(k,Buffer.alloc(8193));await assert.rejects(port.read({bucket,key:k,deadline:Date.now()+1000}),{code:'RECONCILIATION_STORAGE_BODY_LIMIT'});
});
test('sidecar extension admits no arbitrary JSON location or overwrite option',async()=>{
 let calls=0;const port=createReconciliationStorage({projectUrl,serviceKey,fetchImpl:async()=>{calls++;throw Error('UNREACHABLE');}}),k=key();for(const changed of[k.replace('/observations/','/responses/'),k.replace('.json','.xml'),k.replace('reconciliation/','candidates/'),k+'/other','reconciliation/../observations/hash.json'])await assert.rejects(port.putImmutable(write(changed,Buffer.from('{}'))),{code:'RECONCILIATION_STORAGE_INPUT_INVALID'});await assert.rejects(port.putImmutable({...write(k,Buffer.from('{}')),upsert:true}),{code:'RECONCILIATION_STORAGE_WRITE_INVALID'});assert.equal(calls,0);
});
